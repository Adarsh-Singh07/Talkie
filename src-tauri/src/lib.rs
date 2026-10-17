use std::{str::FromStr, sync::{Arc, Mutex}};

use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

fn push_to_talk() -> Shortcut {
    Shortcut::new(None, Code::Space)
}

#[derive(Clone)]
struct ShortcutStateStore {
    current: Arc<Mutex<Shortcut>>,
}

fn emit_lifecycle_event(app: &AppHandle, event: &str) {
    let _ = app.emit(event, ());
}

#[tauri::command]
fn set_global_shortcut(app: AppHandle, state: State<'_, ShortcutStateStore>, value: String) -> Result<String, String> {
    let next = Shortcut::from_str(value.trim()).map_err(|error| error.to_string())?;
    let mut current = state.current.lock().map_err(|_| "shortcut state unavailable".to_string())?;
    if *current == next { return Ok(next.to_string()); }
    app.global_shortcut().unregister(*current).map_err(|error| error.to_string())?;
    if let Err(error) = app.global_shortcut().register(next) {
        let _ = app.global_shortcut().register(*current);
        return Err(error.to_string());
    }
    *current = next;
    Ok(next.to_string())
}

pub fn run() {
    let shortcut_state = ShortcutStateStore { current: Arc::new(Mutex::new(push_to_talk())) };
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let event_name = match event.state() {
                        ShortcutState::Pressed => "shortcut://pressed",
                        ShortcutState::Released => "shortcut://released",
                    };
                    let _ = app.emit(event_name, shortcut.to_string());
                })
                .build(),
        )
        .manage(shortcut_state)
        .invoke_handler(tauri::generate_handler![set_global_shortcut])
        .setup(|app| {
            app.global_shortcut().register(push_to_talk())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) => emit_lifecycle_event(&window.app_handle(), "window://focused"),
            WindowEvent::CloseRequested { .. } => {
                emit_lifecycle_event(&window.app_handle(), "window://close-requested")
            }
            WindowEvent::Destroyed => emit_lifecycle_event(&window.app_handle(), "window://destroyed"),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Talkie");
}
