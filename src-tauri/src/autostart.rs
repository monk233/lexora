//! Start-at-login support.
//!
//! The official autostart plugins write the raw executable path into
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which breaks when the
//! path contains spaces (common for portable installs such as
//! `D:\Tools\Lingo Pick\lexora.exe`). We write the value ourselves so the
//! executable is always quoted.

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Lexora";

fn current_exe() -> Option<String> {
    std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

/// Command line stored in the registry, e.g. `"C:\Tools\Lexora\lexora.exe" --autostart`.
pub fn command_line() -> Option<String> {
    current_exe().map(|exe| format!("\"{exe}\" --autostart"))
}

/// True when the Run entry exists and points at the current executable.
pub fn is_enabled() -> bool {
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ)
    else {
        return false;
    };
    let Ok(stored) = key.get_value::<String, _>(VALUE_NAME) else {
        return false;
    };
    let Some(exe) = current_exe() else {
        return false;
    };
    stored
        .to_ascii_lowercase()
        .contains(&exe.to_ascii_lowercase())
}

/// Creates or removes the Run entry. Idempotent.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if enabled {
        let command = command_line().ok_or_else(|| "无法确定程序路径".to_string())?;
        let (key, _) = hkcu
            .create_subkey(RUN_KEY)
            .map_err(|error| format!("无法打开开机启动注册表项：{error}"))?;
        key.set_value(VALUE_NAME, &command)
            .map_err(|error| format!("写入开机启动项失败：{error}"))
    } else {
        let key = hkcu
            .open_subkey_with_flags(RUN_KEY, KEY_WRITE)
            .map_err(|error| format!("无法打开开机启动注册表项：{error}"))?;
        match key.delete_value(VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("删除开机启动项失败：{error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quotes_the_executable() {
        let command = command_line().expect("current exe path");
        assert!(command.starts_with('"'));
        assert!(command.ends_with("\" --autostart"));
    }
}
