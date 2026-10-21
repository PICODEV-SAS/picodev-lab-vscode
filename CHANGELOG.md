# Changelog

Picodev Lab for VS Code, newest first. A version is a `vX.Y.Z` tag of this repository.

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
