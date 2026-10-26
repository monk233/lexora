#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Lexora — Windows selection translator.
//!
//! A tray-resident Tauri app: global input hooks detect text selections, UI
//! Automation reads the selected text, a transparent always-on-top webview shows
//! translation actions, and translations come either from an OpenAI-compatible
//! HTTP endpoint or from a locally managed llama.cpp server.
//!
//! This file owns the process lifecycle: plugins (single instance first),
//! startup, window events, autostart synchronization and shutdown cleanup.

mod autostart;
mod capture;
mod capture_hover;
mod commands;
mod engine;
mod logger;
mod longshot;
mod paths;
mod pin;
mod selection;
mod settings;
mod state;
mod tray;
mod updater;
mod win32;
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use state::AppState;

fn main() {
    ensure_webview2_scheduling_args();
    let app = tauri::Builder::default()
        // The single-instance plugin must be registered before any other plugin.
        // A second launch never opens a window on its own (a plain double-click
        // stays silent); pass `--show` to explicitly bring settings up.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let force_show = wants_settings_window(&args);
            let autostart_launch = is_autostart_launch(&args);
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.log.info(&format!(
                    "second instance launched: args={args:?} cwd={cwd:?}; \
                     force_show={force_show} autostart={autostart_launch}"
                ));
            }
            if force_show {
                windows::show_settings(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = paths::AppPaths::resolve();
            let log = logger::Logger::new(&paths.logs_dir, "main");
            log.info(&format!(
                "=== Lexora {} starting (os={}, exe={:?}, args={:?}) ===",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::current_exe().ok(),
                std::env::args().collect::<Vec<_>>()
            ));
            log.info(&format!("data dir: {}", paths.data_dir.display()));

            let panic_log = log.clone();
            std::panic::set_hook(Box::new(move |info| {
                panic_log.error(&format!("panic: {info}"));
            }));

            let state = AppState::new(paths, log.clone());
            app.manage(state.clone());

            if let Err(error) = tray::setup(app) {
                log.warn(&format!("tray setup failed: {error}"));
            }

            state.selection.start(app.handle().clone());
            crate::capture::start_hotkey_listener(app.handle().clone());

            // The picker/settings windows are shown and hidden all the time; a
            // DWM fade would read as a flash on capture exit (round 21). Disable
            // their open/close transitions as well.
            for label in [windows::SETTINGS_LABEL, windows::PICKER_LABEL] {
                if let Some(window) = app.get_webview_window(label) {
                    if !crate::win32::disable_transitions(&window) {
                        log.warn(&format!("could not disable transitions for '{label}'"));
                    }
                }
            }

            sync_autostart(&state);
            restore_local_engine(app.handle(), &state);

            let args: Vec<String> = std::env::args().collect();
            let force_show = wants_settings_window(&args);
            let autostart_launch = is_autostart_launch(&args);

            // Silent start: a launch only mounts the tray (and picker) and
            // never opens a window. `--show` is an explicit opt-in used by
            // developers and tests.
            log.info(&format!(
                "startup mode: force_show={force_show} autostart={autostart_launch}; \
                 starting silently in tray"
            ));
            if force_show {
                windows::show_settings(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => match window.label() {
                windows::SETTINGS_LABEL => {
                    let app = window.app_handle();
                    let close_to_tray = app
                        .try_state::<Arc<AppState>>()
                        .map(|state| state.settings.get().app.close_to_tray)
                        .unwrap_or(true);
                    if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                        if let Some(state) = app.try_state::<Arc<AppState>>() {
                            state.log.info("settings window closed to tray");
                        }
                    } else {
                        // Tray-resident behavior disabled: quit the app.
                        api.prevent_close();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            app.exit(0);
                        });
                    }
                }
                windows::PICKER_LABEL => {
                    api.prevent_close();
                    windows::hide_picker(window.app_handle());
                }
                label if label.starts_with(crate::pin::PIN_PREFIX) => {
                    // A pinned window is closed through `pin_close` (buttons,
                    // double click, Esc, Alt+F4) so the registry is cleaned up.
                    api.prevent_close();
                    if let Some(id) = crate::pin::pin_id_from_label(label) {
                        crate::pin::close(window.app_handle(), id);
                    }
                }
                label if label == crate::longshot::LONG_SHOT_LABEL
                    || label == crate::longshot::LONG_SHOT_BAR_LABEL =>
                {
                    // Closing the preview or its control bar (Alt+F4 / OS close)
                    // behaves like the cancel button: stop stitching and restore
                    // the overlay.
                    api.prevent_close();
                    // Defer destroying the windows until after this close event
                    // has been processed.
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        crate::longshot::cancel(&app);
                    });
                }
                label if label.starts_with(crate::windows::CAPTURE_PREFIX) => {
                    // Never let an overlay be destroyed behind the service's
                    // back: the single-flight guard treats an existing session
                    // as "already capturing" (contract §11.11.2), so close the
                    // capture flow instead of leaving a stuck session.
                    api.prevent_close();
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<Arc<AppState>>() {
                        state.capture.close(app);
                        windows::hide_capture_windows(app);
                    }
                }
                _ => {}
            },
            WindowEvent::Destroyed => {
                if let Some(id) = crate::pin::pin_id_from_label(window.label()) {
                    crate::pin::forget(id);
                }
                if window.label() == crate::longshot::LONG_SHOT_LABEL
                    || window.label() == crate::longshot::LONG_SHOT_BAR_LABEL
                {
                    // A longshot window is gone: never leave the grab thread or
                    // its buffered image running behind the shell's back.
                    crate::longshot::forget_session(window.app_handle());
                }
            }
            WindowEvent::Focused(false) => {
                if window.label() == windows::PICKER_LABEL {
                    windows::handle_picker_blur(window.app_handle());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::update_settings,
            commands::reset_settings,
            commands::test_online,
            commands::list_online_models,
            commands::download_engine,
            commands::download_model,
            commands::cancel_download,
            commands::import_model,
            commands::remove_model,
            commands::start_local,
            commands::stop_local,
            commands::open_dir,
            commands::open_external,
            commands::set_start_at_login,
            commands::quit_app,
            commands::check_update,
            commands::install_update,
            commands::start_capture,
            commands::capture_monitor_info,
            capture_hover::capture_hover_at,
            capture_hover::capture_cursor,
            capture_hover::capture_layout,
            commands::capture_ready,
            commands::capture_copy,
            commands::capture_copy_text,
            commands::capture_skill,
            commands::capture_retry,
            commands::capture_followup,
            commands::capture_close,
            commands::capture_set_hotkey,
            commands::capture_pin,
            commands::capture_longshot,
            longshot::longshot_start,
            longshot::longshot_state,
            longshot::longshot_preview,
            longshot::longshot_preview_ready,
            longshot::longshot_direction,
            longshot::longshot_autoscroll,
            longshot::longshot_finish,
            longshot::longshot_cancel,
            commands::pin_ready,
            commands::pin_drag,
            commands::pin_zoom,
            commands::pin_edit_window,
            commands::pin_skill,
            commands::pin_export_annotations,
            commands::pin_copy,
            commands::pin_close,
            commands::picker_ready,
            commands::picker_close,
            commands::picker_pin,
            commands::picker_panel_state,
            commands::picker_activate,
            commands::picker_resize,
            commands::picker_drag_panel,
            commands::picker_copy,
            commands::picker_open_settings,
            commands::picker_translate,
            commands::picker_polish,
            commands::picker_custom_skill,
            commands::picker_abort_translate,
            commands::picker_assist,
            commands::picker_followup,
            commands::picker_status,
            commands::picker_disable_in_app,
            commands::picker_disable_tool
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lexora");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } => cleanup(app_handle),
        RunEvent::Exit => cleanup(app_handle),
        _ => {}
    });
}

/// Keeps the autostart registry entry in sync with the persisted setting.
///
/// We write `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` ourselves (see
/// `autostart.rs`) so executable paths containing spaces stay quoted. The entry
/// is only touched when the persisted value differs, so manual changes are not
/// overwritten on every launch.
fn sync_autostart(state: &AppState) {
    if commands::portable_mode() {
        state
            .log
            .info("portable environment detected: autostart is not supported");
        return;
    }
    let wanted = state.settings.get().app.start_at_login;
    let current = autostart::is_enabled();
    if current == wanted {
        return;
    }
    match autostart::set_enabled(wanted) {
        Ok(()) => state
            .log
            .info(&format!("autostart synchronized to {wanted}")),
        Err(error) => state.log.warn(&format!(
            "failed to synchronize autostart to {wanted}: {error}"
        )),
    }
}

/// Restores the local llama.cpp engine when it was running in the previous
/// session (`provider.local.keepRunning`). Runs in the background so a slow
/// model load never delays window creation; failures are only logged (a silent
/// startup must not pop an error box).
fn restore_local_engine(app: &AppHandle, state: &Arc<AppState>) {
    let settings = state.settings.get();
    if !should_restore_local(settings.provider.local.keep_running) {
        return;
    }
    if !state.engine.engine_installed() {
        state
            .log
            .info("local engine restore skipped: llama.cpp engine is not installed");
        return;
    }
    if state.engine.installed_models().is_empty() {
        state
            .log
            .info("local engine restore skipped: no local model installed");
        return;
    }
    state
        .log
        .info("restoring local engine from the previous session");
    let engine = state.engine.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match engine.start_local().await {
            Ok(()) => {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    state
                        .log
                        .info("local engine restored; last running state remembered");
                    crate::tray::refresh(&app);
                    commands::broadcast_state(&app, &state);
                }
            }
            Err(error) => {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    state.log.warn(&format!(
                        "local engine restore failed: {} ({})",
                        error.message, error.hint
                    ));
                }
            }
        }
    });
}

/// Pure gate for [`restore_local_engine`] (kept testable without an app).
fn should_restore_local(keep_running: bool) -> bool {
    keep_running
}

/// Stops the local llama.cpp server and drops UI state before the process exits.
/// Idempotent: both `ExitRequested` and `Exit` call it.
fn cleanup(app: &AppHandle) {
    static CLEANED_UP: AtomicBool = AtomicBool::new(false);
    if CLEANED_UP.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    state.log.info("shutdown: cleanup started");
    state.set_quitting();
    state.abort_translate();
    state.selection.set_picker_visible(false);
    let pinned = crate::pin::pin_count();
    if pinned > 0 {
        state
            .log
            .info(&format!("shutdown: dropping {pinned} pinned window(s)"));
    }
    crate::pin::clear_registry();
    // Stop the manual long-screenshot grab thread (if any); the preview window
    // dies with the process.
    crate::longshot::forget_session(app);

    // `shutdown_local` completes synchronously (process kill) and deliberately
    // keeps `local.keepRunning` so the next launch restores the engine; spawn +
    // a short wait is enough and cannot deadlock the main thread.
    let engine = state.engine.clone();
    let (sender, receiver) = std::sync::mpsc::channel::<()>();
    tauri::async_runtime::spawn(async move {
        engine.shutdown_local();
        let _ = sender.send(());
    });
    if receiver.recv_timeout(Duration::from_millis(1500)).is_err() {
        state
            .log
            .warn("local engine stop timed out; it will be terminated with this process");
    }
    state.log.info("shutdown: cleanup finished");
}

/// The screenshot overlays are hidden most of the time: they are reused
/// webviews that must fetch and paint the next screenshot **while still
/// hidden**, then call `capture_ready` (contract §10.1). Chromium/WebView2
/// otherwise throttles background timers and suspends occluded windows, which
/// real-world logs showed as a 2.5 s fallback delay. The environment variable
/// is inherited by every WebView2 instance this process creates.
fn ensure_webview2_scheduling_args() {
    const FLAGS: [&str; 4] = [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
    ];
    let key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let existing = std::env::var(key).unwrap_or_default();
    let mut args = existing.trim().to_string();
    for flag in FLAGS {
        if !args.contains(flag) {
            if !args.is_empty() {
                args.push(' ');
            }
            args.push_str(flag);
        }
    }
    std::env::set_var(key, args);
}

/// The settings window is only shown on an explicit `--show` launch. A plain
/// double-click (and a start-at-login run) stays silent in the tray.
fn wants_settings_window(args: &[String]) -> bool {
    args.iter().any(|argument| argument == "--show")
}

/// Start-at-login launches pass `--autostart` (written by `autostart.rs`).
fn is_autostart_launch(args: &[String]) -> bool {
    args.iter().any(|argument| argument == "--autostart")
}

#[cfg(test)]
mod tests {
    use super::{is_autostart_launch, should_restore_local, wants_settings_window};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn local_engine_restore_follows_the_last_running_state() {
        assert!(!should_restore_local(false));
        assert!(should_restore_local(true));
    }

    #[test]
    fn double_click_launch_stays_silent() {
        assert!(!wants_settings_window(&args(&["lexora.exe"])));
        assert!(!wants_settings_window(&args(&[
            "lexora.exe",
            "--autostart"
        ])));
    }

    #[test]
    fn show_flag_opens_settings() {
        assert!(wants_settings_window(&args(&["lexora.exe", "--show"])));
        assert!(wants_settings_window(&args(&["--show", "--autostart"])));
        assert!(!wants_settings_window(&args(&["lexora.exe", "--show-all"])));
    }

    #[test]
    fn autostart_flag_is_detected() {
        assert!(is_autostart_launch(&args(&["lexora.exe", "--autostart"])));
        assert!(!is_autostart_launch(&args(&["lexora.exe", "--show"])));
    }
}
