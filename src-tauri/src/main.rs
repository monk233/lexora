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
mod commands;
mod engine;
mod logger;
mod paths;
mod selection;
mod settings;
mod state;
mod tray;
mod win32;
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use state::AppState;

fn main() {
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
            sync_autostart(&state);

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
                _ => {}
            },
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
            commands::picker_ready,
            commands::picker_close,
            commands::picker_pin,
            commands::picker_resize,
            commands::picker_drag_panel,
            commands::picker_copy,
            commands::picker_open_settings,
            commands::picker_translate,
            commands::picker_polish,
            commands::picker_custom_skill,
            commands::picker_abort_translate,
            commands::picker_assist,
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

    // `stop_local` completes synchronously (process kill), so spawn + a short
    // wait is enough and cannot deadlock the main thread.
    let engine = state.engine.clone();
    let (sender, receiver) = std::sync::mpsc::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = engine.stop_local().await;
        let _ = sender.send(());
    });
    if receiver.recv_timeout(Duration::from_millis(1500)).is_err() {
        state
            .log
            .warn("local engine stop timed out; it will be terminated with this process");
    }
    state.log.info("shutdown: cleanup finished");
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
    use super::{is_autostart_launch, wants_settings_window};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
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
