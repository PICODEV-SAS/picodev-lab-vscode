# Changelog

Picodev Lab for VS Code, newest first. A version is a `vX.Y.Z` tag of this repository.

## 0.11.1

- The *Get started with Picodev Lab* walkthrough opens once by itself, the first time the extension
  starts (also after an update), and from the palette with *Picodev Lab: Get started*.

## 0.11.0

- Each step of the *Get started with Picodev Lab* walkthrough shows its own animated picture
  (opening the sketch, picking a setup, the bench in the browser, the agent's chat, the local
  compilation) instead of the logo. They follow the colour theme, light, dark or high contrast.

## 0.10.0

Contract 0.21, with `picodev-lab-client` 0.9.0.

- The agent instructions explain `submit_answer` for tests whose spec is `{"type":"answer"}`, and that hints are only those revealed in the bench.
- The Challenge tab lists only the hints the lab reports as revealed (`brief.hints`); the sheet's English hints are no longer used.

## 0.9.1

- No change to the extension: first release published to the VS Code Marketplace through Entra ID instead of a personal access token.

## 0.9.0

Contract 0.20, with `picodev-lab-client` 0.8.0.

- Copilot gets the session from the lab's MCP server itself: the extension's server definition
  carries it in the `X-Lab-Session` and `X-Lab-Agent-Token` headers while the active folder holds a
  session, renewed on open, end and folder switch. *Give it to Copilot* no longer quotes the session
  or its token in the chat; the Claude Code message still does.
- **Real bench** tab (*Banc réel*): the setup's real bench offers (*soon* ones too), your place in
  the queue or your turn and its remaining time, join the queue, leave it or give back the turn.
  The camera is in the Lab panel; *Open the bench* opens it in your browser.
- Share: the link is the one the lab signs (`share` in `session_status`), with the levels and the
  time it recorded; a lab that gives none gets the link built as before.
- Lab errors are told apart by the code the lab sends, no longer by their wording.
- A program over 48 KiB of HEX is compiled by the lab, as in the Claude Code plugin, instead of failing.
- Multi-root workspaces: one session per workspace folder; the status bar and the view follow the
  folder of the active file, and a save pushes only to its own folder's session.
- *Save All* pushes the sketch once: the saves of a burst share one push.
- The integration test runs against a local mock of the lab; `PICODEV_LAB_LIVE=1` runs it on the lab.

## 0.8.0 (2026-10-22)

- Opening a session with no `.ino` in the folder writes the bench's sketch there (what the bench shows,
  else the setup's starting sketch) and opens it: edit it here, each save sends it (auto-push). With no
  folder open, it goes to `~/picodev-lab/<setup>/`. A file already there is never overwritten.

## 0.7.1 (2026-10-21)

- The Marketplace page shows previews of the extension at work, and a short section in French.
- Release: the publish workflow can be run by hand for a tag (when the tag push did not start it).

## 0.7.0 (2026-10-21)

- Public: the source is at [PICODEV-SAS/picodev-lab-vscode](https://github.com/PICODEV-SAS/picodev-lab-vscode),
  one commit per release. The client of the lab's MCP comes from
  [PICODEV-SAS/picodev-lab-client](https://github.com/PICODEV-SAS/picodev-lab-client).
- Each release is published to the VS Code Marketplace and Open VSX, and its `.vsix` is attached to the
  GitHub release.

## 0.6.0 (2026-10-20)

- Illustrated spec (contract 0.16): a figure is a line `![caption](spec-figures/x.png)` (or `.svg`) in
  its section of `spec-projet.md`; the PDF preview and the send carry the figures (3 at most, 200 KiB
  each, files in the spec's folder only). The agent's interview offers to illustrate the project (use,
  shape, block diagram) as an SVG, shows it, and keeps it only on an explicit yes.
- Contact details in the document: a `## Coordonnées` (or `## Contact details`) section, printed at the
  end of the PDF; the interview asks first. The Project tab says how many illustrations and whether the
  contact details are in.
- The spec's language is the one its headings are written in (French headings: French PDF), else VS
  Code's; the interview writes in the language the visitor answers in.
- *Create a spec workspace* (command, and offered by *Describe my project* with no folder open): a new
  folder with `spec-projet.md` and `spec-figures/`, opened in the window; the interview resumes there.

## 0.5.2 (2026-10-20)

- The Project tab follows the interview as the agent writes: it follows the `spec-projet.md` it sees
  change (a subfolder too, or a folder outside the workspace), and the agent's interview prompt gives
  the file's exact path. The agent points to *PDF preview* when the spec is ready.

## 0.5.1 (2026-10-20)

- *Describe my project* with no folder open: the extension asks where to write `spec-projet.md`
  instead of failing with "Open a folder first".

## 0.5.0 (2026-10-20)

- **Project** tab, as the Claude Code plugin's: what the spec is and that Picodev helps formalize
  your project, the eight sections of `spec-projet.md` (written, in progress, to write, followed as
  the file changes), the interview (here or by the agent), the PDF preview, sending to Picodev, and
  meeting / questions.
- No **Sim** tab: what the simulation does is in the bench, in your browser. The last compilation
  (its state, its errors, *Ask … to fix*) moves to the Session card. The agent's capture is no longer
  read or shown.
- Share: LinkedIn and X (no Bluesky). The Share tab shows once there is a result to share.

## 0.4.0 (2026-10-20)

- The agent is Copilot or Claude Code: setting `picodevLab.agent` (`auto`, `claude`, `copilot`);
  `auto` is Claude Code when its extension is installed. The session, the fixes and the project
  interview go to the chosen agent's chat.
- Claude Code without the lab's tools: the extension offers to add the lab's MCP server to it
  (`claude mcp add --scope user`).
- Opening a session also opens the Lab panel beside the editor.

## 0.3.0 (2026-10-19)

- Binary first: the sketch is compiled on your machine with arduino-cli for the setup's board and
  the program is sent (`push_program`). The lab compiles only when the toolchain is missing; a code
  error is not sent, its errors go to the Problems panel.
- A local git repository for the sketch, offered once, with a commit after each push. Never pushed.
- Guidance: the next step on one line, the walkthrough.

## 0.2.0 (2026-10-19)

- Describe my project: the lab's interview (`spec_draft`), `spec-projet.md`, the PDF from Picodev's
  template, sending after consent (`brief_submit`).
- Meeting / questions (`request_meeting`).

## 0.1.4 (2026-10-14)

- The view in tabs; Picodev icons.

## 0.1.3 (2026-10-14)

- Challenge content and setup picker in English when VS Code is not in French.

## 0.1.2 (2026-10-14)

- The Lab panel shows the session's spectator page; Copilot pushes; *Next level*.
