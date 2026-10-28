//! Native update notifications with a stable identity, including portable builds.

#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

pub const AUMID: &str = "io.github.monk233.lexora";
const TITLE: &str = "Lexora 有新版本";

fn update_body(version: &str) -> String {
    format!("Lexora v{version} 已发布。打开设置查看更新说明并下载。")
}

/// Called before the UI is created. Failure must not prevent application startup.
pub fn set_process_identity() -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
            &windows::core::HSTRING::from(AUMID),
        )
        .map_err(|error| format!("set process AUMID: {error}"))?;
    }
    Ok(())
}

pub fn initialize() -> Result<(), String> {
    #[cfg(windows)]
    return native::initialize().map(|_| ());
    #[cfg(not(windows))]
    Ok(())
}

pub fn show_update_available(app: &tauri::AppHandle, version: &str) -> Result<(), String> {
    let body = update_body(version);
    #[cfg(windows)]
    {
        native::show(&body).map_err(|error| {
            use tauri::Manager;
            if let Some(state) = app.try_state::<std::sync::Arc<crate::state::AppState>>() {
                state
                    .log
                    .warn(&format!("native update notification failed: {error}"));
            }
            error
        })
    }
    #[cfg(not(windows))]
    app.notification()
        .builder()
        .title(TITLE)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
mod native {
    use super::{AUMID, TITLE};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use windows::core::{Interface, GUID, HSTRING};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        FOLDERID_LocalAppData, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, SHStrDupW,
        ShellLink, KF_FLAG_DEFAULT, SLGP_RAWPATH,
    };

    static IDENTITY: OnceLock<PathBuf> = OnceLock::new();
    static INITIALIZING: Mutex<()> = Mutex::new(());
    // System.AppUserModel.ID, from propkey.h.
    const APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    pub(super) fn registry_path() -> String {
        format!(r"Software\Classes\AppUserModelId\{AUMID}")
    }

    pub(super) fn shortcut_path(programs: &Path) -> PathBuf {
        programs.join("Lexora.lnk")
    }

    pub(super) fn initialize() -> Result<&'static Path, String> {
        let _guard = INITIALIZING.lock().map_err(|error| error.to_string())?;
        cached_identity(&IDENTITY, || {
            // A dedicated apartment avoids conflicting with Tauri's COM initialization.
            std::thread::Builder::new()
                .name("notification-identity".into())
                .spawn(register_identity)
                .map_err(|error| error.to_string())?
                .join()
                .map_err(|_| "notification identity thread panicked".to_string())?
        })
    }

    // Failed registration must remain retryable on the next update check.
    pub(super) fn cached_identity(
        cache: &OnceLock<PathBuf>,
        register: impl FnOnce() -> Result<PathBuf, String>,
    ) -> Result<&Path, String> {
        if let Some(icon) = cache.get() {
            return Ok(icon.as_path());
        }
        let icon = register()?;
        let _ = cache.set(icon);
        Ok(cache.get().unwrap().as_path())
    }

    fn register_identity() -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
            .map_err(|error| format!("initialize shortcut reader: {error}"))?;
        let _apartment = Apartment;
        let shortcut = shortcut_path(&known_folder(&FOLDERID_Programs).map_err(|e| e.to_string())?);
        let existing = read_shortcut_target(&shortcut)?;
        let repair =
            should_repair_target(existing.as_deref(), &exe, |path| {
                match std::fs::metadata(path) {
                    Ok(metadata) => Ok(metadata.is_file()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                    Err(error) => Err(error.to_string()),
                }
            })?;
        // Another valid installation owns the shared identity. Do not change it.
        if !repair {
            return winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                .open_subkey(registry_path())
                .and_then(|key| key.get_value::<String, _>("IconUri"))
                .map(PathBuf::from)
                .and_then(|icon| {
                    if icon.is_absolute() && icon.is_file() {
                        Ok(icon)
                    } else {
                        Err(std::io::Error::other(
                            "existing notification icon is unavailable",
                        ))
                    }
                })
                .map_err(|error| format!("preserved existing notification identity: {error}"));
        }
        // A raster appLogoOverride must not refer to the executable. Keep the embedded
        // PNG outside the executable directory so in-place updates preserve its path.
        let local = known_folder(&FOLDERID_LocalAppData).map_err(|error| error.to_string())?;
        let icon = local.join("Lexora").join("notification").join("icon.png");
        let bytes = include_bytes!("../icons/128x128.png");
        std::fs::create_dir_all(icon.parent().unwrap()).map_err(|error| error.to_string())?;
        if std::fs::read(&icon).ok().as_deref() != Some(bytes.as_slice()) {
            std::fs::write(&icon, bytes).map_err(|error| error.to_string())?;
        }
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(registry_path())
            .map_err(|error| format!("create notification identity: {error}"))?
            .0;
        key.set_value("DisplayName", &"Lexora")
            .and_then(|_| key.set_value("IconUri", &icon.as_os_str()))
            .map_err(|error| format!("register notification identity: {error}"))?;
        create_shortcut(&exe).map_err(|error| format!("register Start Menu shortcut: {error}"))?;
        Ok(icon)
    }

    pub(super) fn should_repair_target(
        existing: Option<&Path>,
        current: &Path,
        valid: impl FnOnce(&Path) -> Result<bool, String>,
    ) -> Result<bool, String> {
        match existing {
            None => Ok(true),
            Some(target) if target == current => Ok(true),
            Some(target) => valid(target).map(|exists| !exists),
        }
    }

    fn read_shortcut_target(shortcut: &Path) -> Result<Option<PathBuf>, String> {
        match std::fs::symlink_metadata(shortcut) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("inspect existing shortcut: {error}")),
            Ok(_) => {}
        }
        let read = || -> windows::core::Result<PathBuf> {
            unsafe {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                let file: IPersistFile = link.cast()?;
                file.Load(&HSTRING::from(shortcut.as_os_str()), STGM_READ)?;
                let mut buffer = [0u16; 32768];
                link.GetPath(&mut buffer, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)?;
                let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                use std::os::windows::ffi::OsStringExt;
                Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..end])))
            }
        };
        let target = read()
            .map_err(|error| format!("read existing shortcut; refusing overwrite: {error}"))?;
        if !target.is_absolute() {
            return Err("existing shortcut target is empty or relative; refusing overwrite".into());
        }
        Ok(Some(target))
    }

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn known_folder(id: &GUID) -> windows::core::Result<PathBuf> {
        unsafe {
            let folder = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None)?;
            let path = folder.to_string();
            CoTaskMemFree(Some(folder.0.cast()));
            Ok(PathBuf::from(path?))
        }
    }

    fn create_shortcut(exe: &Path) -> windows::core::Result<()> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            let _apartment = Apartment;
            let shortcut = shortcut_path(&known_folder(&FOLDERID_Programs)?);
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let exe_string = HSTRING::from(exe.as_os_str());
            link.SetPath(&exe_string)?;
            link.SetWorkingDirectory(&HSTRING::from(exe.parent().unwrap_or(exe).as_os_str()))?;
            link.SetDescription(&HSTRING::from("Lexora"))?;
            link.SetIconLocation(&exe_string, 0)?;
            let store: IPropertyStore = link.cast()?;
            // The Shell property expects VT_LPWSTR. PROPVARIANT owns the COM allocation.
            let mut identity = PROPVARIANT::default();
            let value = &mut *identity.Anonymous.Anonymous;
            value.vt = VT_LPWSTR;
            value.Anonymous.pwszVal = SHStrDupW(&HSTRING::from(AUMID))?;
            store.SetValue(&APP_USER_MODEL_ID, &identity)?;
            store.Commit()?;
            let file: IPersistFile = link.cast()?;
            file.Save(&HSTRING::from(shortcut.as_os_str()), true)?;
        }
        Ok(())
    }

    pub(super) fn show(body: &str) -> Result<(), String> {
        // Do not silently send under an unregistered identity after initialization failed.
        let icon = initialize()?;
        tauri_winrt_notification::Toast::new(AUMID)
            .title(TITLE)
            .text1(body)
            .icon(icon, tauri_winrt_notification::IconCrop::Square, "Lexora")
            .show()
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_matches_application_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], AUMID);
        assert_eq!(config["productName"], "Lexora");
    }

    #[test]
    fn update_message_preserves_version() {
        assert_eq!(
            update_body("0.4.0"),
            "Lexora v0.4.0 已发布。打开设置查看更新说明并下载。"
        );
    }

    #[cfg(windows)]
    #[test]
    fn identity_paths_do_not_depend_on_build_or_version() {
        assert_eq!(
            native::registry_path(),
            r"Software\Classes\AppUserModelId\io.github.monk233.lexora"
        );
        let programs = std::path::Path::new(r"C:\Users\测试 用户\Start Menu\Programs");
        assert_eq!(native::shortcut_path(programs), programs.join("Lexora.lnk"));
    }

    #[cfg(windows)]
    #[test]
    fn shortcut_repair_preserves_other_valid_installation() {
        use std::path::Path;
        let current = Path::new(r"D:\portable\lexora.exe");
        let installed = Path::new(r"C:\Apps\Lexora\lexora.exe");
        assert!(!native::should_repair_target(Some(installed), current, |_| Ok(true)).unwrap());
        assert!(native::should_repair_target(Some(installed), current, |_| Ok(false)).unwrap());
        assert!(
            native::should_repair_target(Some(current), current, |_| panic!("same target"))
                .unwrap()
        );
        assert!(native::should_repair_target(None, current, |_| panic!("no target")).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn shortcut_inspection_error_does_not_authorize_repair() {
        use std::path::Path;
        assert_eq!(
            native::should_repair_target(
                Some(Path::new(r"C:\Apps\Lexora\lexora.exe")),
                Path::new(r"D:\portable\lexora.exe"),
                |_| Err("access denied".into()),
            ),
            Err("access denied".into())
        );
    }

    #[cfg(windows)]
    #[test]
    fn identity_errors_are_propagated_and_registration_can_retry() {
        let cache = std::sync::OnceLock::new();
        assert_eq!(
            native::cached_identity(&cache, || Err("registration failed".into())).unwrap_err(),
            "registration failed"
        );
        assert!(cache.get().is_none());
        let icon = std::path::PathBuf::from(r"C:\stable\icon.png");
        assert_eq!(
            native::cached_identity(&cache, || Ok(icon.clone())).unwrap(),
            icon
        );
        assert_eq!(
            native::cached_identity(&cache, || panic!("already registered")).unwrap(),
            icon
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Requires identity initialized by Lexora; sends a real Windows notification"]
    fn windows_notification_smoke() {
        // Never register current_exe() here: it is the test harness, not Lexora.
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey(native::registry_path())
            .expect("Run Lexora once to initialize its notification identity first");
        assert_eq!(key.get_value::<String, _>("DisplayName").unwrap(), "Lexora");
        tauri_winrt_notification::Toast::new(AUMID)
            .title("Lexora 通知测试")
            .text1("Lexora 原生通知测试。此通知不会更改更新版本去重记录。")
            .show()
            .unwrap();
    }
}
