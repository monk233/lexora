//! System tray integration.
//!
//! Menu layout (contract §6.3):
//!
//! * 显示设置 — opens/focuses the settings window;
//! * 启用划词 — check item, mirrors `settings.picker.enabled`, toggles and
//!   persists on click;
//! * 本地模型 — starts or stops the local llama.cpp server depending on its
//!   current state;
//! * 退出 — quits the app (the engine is stopped from `main.rs` on exit).
//!
//! Double-clicking the tray icon (Windows only event) opens the settings window.

use std::sync::Arc;

use serde_json::json;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::state::AppState;

pub const TRAY_ID: &str = "lingopick-tray";

const MENU_SHOW_SETTINGS: &str = "lingopick:show-settings";
const MENU_TOGGLE_PICKER: &str = "lingopick:toggle-picker";
const MENU_TOGGLE_LOCAL: &str = "lingopick:toggle-local";
const MENU_QUIT: &str = "lingopick:quit";

/// Creates the tray icon. Called once from the Tauri `setup` hook.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let menu = build_menu(app.handle())?;
    let icon = match app.default_window_icon() {
        Some(icon) => icon.clone(),
        None => generated_icon(),
    };

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("LingoPick — 划词翻译")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().0.as_str());
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                crate::windows::show_settings(tray.app_handle());
            }
        })
        .build(app)?;

    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.log.info("tray icon created");
    }
    Ok(())
}

/// Rebuilds the tray menu so checked/enabled state follows settings and engine.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                log_warn(app, &format!("tray menu refresh failed: {error}"));
            }
        }
        Err(error) => log_warn(app, &format!("tray menu build failed: {error}")),
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.try_state::<Arc<AppState>>();
    let (picker_enabled, local_running) = match state.as_ref() {
        Some(state) => {
            let settings = state.settings.get();
            let engine = state.engine.status();
            (
                settings.picker.enabled,
                engine.local_state == "ready" || engine.local_state == "starting",
            )
        }
        None => (true, false),
    };

    let show_settings = MenuItem::with_id(app, MENU_SHOW_SETTINGS, "显示设置", true, None::<&str>)?;
    let toggle_picker = CheckMenuItem::with_id(
        app,
        MENU_TOGGLE_PICKER,
        "启用划词",
        true,
        picker_enabled,
        None::<&str>,
    )?;
    let local_label = if local_running {
        "停止本地模型"
    } else {
        "启动本地模型"
    };
    let toggle_local = MenuItem::with_id(app, MENU_TOGGLE_LOCAL, local_label, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出 LingoPick", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &show_settings,
            &toggle_picker,
            &toggle_local,
            &separator,
            &quit,
        ],
    )
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_SHOW_SETTINGS => crate::windows::show_settings(app),
        MENU_TOGGLE_PICKER => toggle_picker_enabled(app),
        MENU_TOGGLE_LOCAL => toggle_local_engine(app),
        MENU_QUIT => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.log.info("quit requested from tray");
                state.set_quitting();
            }
            app.exit(0);
        }
        other => log_warn(app, &format!("unknown tray menu id: {other}")),
    }
}

fn toggle_picker_enabled(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let next = !state.settings.get().picker.enabled;
    match state
        .settings
        .update_json(json!({ "picker": { "enabled": next } }))
    {
        Ok(settings) => {
            state.selection.apply_settings(&settings);
            if !next {
                crate::windows::hide_picker(app);
            }
            refresh(app);
            crate::commands::broadcast_state(app, &state);
            let message = if next {
                "划词工具已启用"
            } else {
                "划词工具已禁用"
            };
            let _ = app.emit_to(
                crate::windows::SETTINGS_LABEL,
                "toast",
                json!({ "type": "info", "message": message }),
            );
            state
                .log
                .info(&format!("picker enabled toggled from tray: {next}"));
        }
        Err(error) => {
            state
                .log
                .error(&format!("tray toggle picker failed: {error}"));
        }
    }
}

fn toggle_local_engine(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let status = state.engine.status();
    let running = status.local_state == "ready" || status.local_state == "starting";
    let engine = state.engine.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = if running {
            engine.stop_local().await
        } else {
            engine.start_local().await
        };
        match result {
            Ok(()) => {
                let message = if running {
                    "本地模型已停止"
                } else {
                    "本地模型已启动"
                };
                let _ = task_app.emit_to(
                    crate::windows::SETTINGS_LABEL,
                    "toast",
                    json!({ "type": "success", "message": message }),
                );
            }
            Err(error) => {
                let _ = task_app.emit_to(
                    crate::windows::SETTINGS_LABEL,
                    "toast",
                    json!({ "type": "error", "message": format!("本地模型操作失败：{}", error.message) }),
                );
                if let Some(state) = task_app.try_state::<Arc<AppState>>() {
                    state
                        .log
                        .error(&format!("tray local engine failed: {}", error.message));
                }
            }
        }
        refresh(&task_app);
        if let Some(state) = task_app.try_state::<Arc<AppState>>() {
            crate::commands::broadcast_state(&task_app, &state);
        }
    });
}

fn log_warn(app: &AppHandle, message: &str) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.log.warn(message);
    }
}

/// Fallback tray icon when no window icon is configured (solid square).
fn generated_icon() -> tauri::image::Image<'static> {
    let size: u32 = 32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let index = ((y * size + x) * 4) as usize;
            let border = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
            let (r, g, b) = if border {
                (67, 56, 202)
            } else {
                (99, 102, 241)
            };
            rgba[index] = r;
            rgba[index + 1] = g;
            rgba[index + 2] = b;
            rgba[index + 3] = 255;
        }
    }
    tauri::image::Image::new_owned(rgba, size, size)
}
