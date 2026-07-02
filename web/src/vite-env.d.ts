/// <reference types="vite/client" />
//
// Pulls in Vite's client ambient module declarations — notably `*?raw` (import a
// file's contents as a string). main.ts imports the listener system prompt from
// ../../prompts/chatgpt.md?raw so the prompt has a single source of truth (the
// same file the promptfoo harness carries) with no drift into a TS copy.
