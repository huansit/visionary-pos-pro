import { invoke } from "@tauri-apps/api/core";
import type { TerminalCredentials } from "./types";

export async function loadTerminalCredentials(): Promise<TerminalCredentials | null> {
  const raw = await invoke<string | null>("load_terminal_credentials");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TerminalCredentials;
  } catch {
    await clearTerminalCredentials();
    return null;
  }
}

export async function saveTerminalCredentials(credentials: TerminalCredentials): Promise<void> {
  await invoke("save_terminal_credentials", { payload: JSON.stringify(credentials) });
}

export async function clearTerminalCredentials(): Promise<void> {
  await invoke("clear_terminal_credentials");
}
