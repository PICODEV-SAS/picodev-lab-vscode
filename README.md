# Picodev Lab for VS Code

Program an Arduino with an AI agent, Claude Code or Copilot, on a **simulated bench in your browser**:
[Picodev Lab](https://lab.picodev.fr). No account, no board, nothing to configure: the lab's MCP server
(`https://lab.picodev.fr/mcp`) is available to Copilot's Agent mode as soon as the extension is installed,
and to Claude Code through its [picodev-lab plugin](https://github.com/PICODEV-SAS/picodev-lab-plugin).

Everything runs in **simulation**, in your browser, powered by [Velxio](https://github.com/davidmonterocrespo24/velxio) (AGPLv3).

## Get started

Picodev Lab needs three things; the walkthrough *Get started with Picodev Lab* (Welcome page, or the
link in the Picodev Lab view) takes you through them:

1. **A folder with your sketch** (an `.ino` file, with its `.h` and `.cpp`). No sketch yet?
   *Picodev Lab: Create a starter sketch* writes the setup's sketch or a blank one.
2. **The bench**: the lab's page in your browser, which simulates the board and the parts wired to
   it. *Picodev Lab: Open a challenge* (levels with tests) or *Open a session* (free mode) opens it.
3. **An AI agent**: *Give the session to the AI agent* (in the view, its title bar, or the palette)
   prefills the agent's chat with the session; send it. The agent writes the code, compiles it and
   drives the bench through the lab's tools. The setting `picodevLab.agent` picks it: `auto` (the
   default) is Claude Code when its extension is installed, else Copilot Chat in Agent mode. Claude Code
   reaches the lab through its MCP server, as Copilot does: the extension offers to add it (or the
   picodev-lab plugin, if installed, brings it). It is usually faster than Copilot.

Opening a session also opens the **Lab panel** beside the editor: the bench's spectator page (a private session needs a viewer link first; the panel offers it).

The Picodev Lab view (activity bar) always shows the next step on one line, and its coral button
is that step.

## Compiled on your machine

On each push (a save, the push button in an `.ino` editor's title bar, or *Push the sketch*), the
extension compiles the sketch with **arduino-cli** for the setup's board and sends the program to
the bench (`push_program`). arduino-cli is looked for in the `picodevLab.arduinoCli` setting, then
on the `PATH`, then in the Arduino extension.

- **The lab compiles** only when the toolchain is missing: no arduino-cli, or the board's core or a
  library not installed (the extension offers once per session to install them).
- **A code error is not sent**: the errors go to the Problems panel and the view, with *Show log*
  and *Ask the agent to fix* (Claude Code or Copilot).
- You always know which way your code went: *compiled on your machine* or *compiled by the lab*.

## A local git repo for your sketch

When a session opens and the sketch's folder is not in a git repo, the extension offers to create
one (with a `.gitignore` of build outputs) and then commits after each successful push. Nothing is
pushed to a git host. Turn it off with `picodevLab.git`.

## What else

- **Status bar**: `Lab · setup-a · Challenge 2/4 · tests 2/3 · 2 viewers`; a click opens the view.
- **The view**: the session and the setup (its schema, parts and probes, the last compilation), the
  challenge (brief, tests, hints, next level), the calls to the lab, your project, and sharing your
  result (LinkedIn, X). What the simulation does is in the bench, in your browser.
- **The Lab panel**: the session's spectator page beside your code (it needs a viewer link).
- **Your project** (its own tab): say what you want to make, and Picodev helps you formalize it.
  The interview (here, or by the AI agent) writes `spec-projet.md`; the tab follows its sections, makes
  the PDF and sends it to Picodev. Nothing is sent without your consent.

## Settings

| Setting | Default | |
|---|---|---|
| `picodevLab.autoPush` | `true` | Push the sketch on each save, while a session is open. |
| `picodevLab.arduinoCli` | empty | Path of arduino-cli. Empty: the `PATH`, then the Arduino extension's. |
| `picodevLab.git` | `true` | Offer a local git repo for the sketch, and commit after each push. |

## Your data

The session (its id, the agent's token, the bench's link) is kept in VS Code's secret storage,
never in your project, and forgotten when it ends. The lab never reads your disk: the extension
sends it your sketch's files (8 files, 64 KiB at most) and the compiled program. Privacy policy:
https://lab.picodev.fr/en/privacy

Also works in VSCodium, Cursor and Windsurf (Open VSX). In an editor that does not read the
extension's MCP declaration, declare the same server in `.vscode/mcp.json`.

## License

Apache 2.0. Copyright 2026 Picodev SAS. [picodev.fr](https://picodev.fr)
