use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn push_to_talk() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

fn emit_lifecycle_event(app: &AppHandle, event: &str) {
    // These events let the frontend mute any in-progress transmission when the
    // window loses focus or is being torn down.
    let _ = app.emit(event, ());
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if *shortcut != push_to_talk() {
                        return;
                    }

                    let event_name = match event.state() {
                        ShortcutState::Pressed => "shortcut://pressed",
                        ShortcutState::Released => "shortcut://released",
                    };
                    let _ = app.emit(event_name, "Ctrl+Shift+Space");
                })
                .build(),
        )
        .setup(|app| {
            app.global_shortcut().register(push_to_talk())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) => emit_lifecycle_event(&window.app_handle(), "window://focused"),
            WindowEvent::Focused(false) => emit_lifecycle_event(&window.app_handle(), "window://blurred"),
            WindowEvent::CloseRequested { .. } => {
                emit_lifecycle_event(&window.app_handle(), "window://close-requested")
            }
            WindowEvent::Destroyed => emit_lifecycle_event(&window.app_handle(), "window://destroyed"),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Talkie");
}
