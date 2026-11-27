# FaberSEP Memory

[![npm](https://img.shields.io/npm/v/@fabersep/memory.svg)](https://www.npmjs.com/package/@fabersep/memory)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**Your AI coding assistant forgets everything when the chat ends. FaberSEP Memory gives it a memory you can read, trust and take with you.**

<!-- Video: a 60-second walkthrough will go here. -->

---

## The problem you already know

It's Monday. You tell your AI assistant: *"We use pnpm here, not npm."* It says "Got it!" and does a great job.

On Tuesday you open a new chat. It runs `npm install`.

So you write the rule down in a long instructions file. A month later that file has 300 lines nobody reads, half of them out of date. You switch from Claude to Antigravity for a day, and the other tool knows none of it. Some tools try to "remember" by themselves, and one day you find a rule in there you never wrote.

## What changes with FaberSEP Memory

The same Monday, with FaberSEP Memory:

1. **Your assistant notices a lesson** ("this team uses pnpm") and *suggests* saving it. It does not save it by itself.
2. **You approve it** with one key press when you have a minute, usually at the end of the day.
3. **From Tuesday on, every assistant you use knows it**: Claude Code, Antigravity, Claude Desktop, Cursor. They all read the same memory.

Your memory is a folder of short notes on your own computer, kept in Git so every change is saved and can be undone. Nothing goes to a cloud service, and you don't need an account, a database or an API key.

## Why you can trust it

- **Nothing gets in without your OK.** Assistants can only suggest. You decide what stays.
- **You can read all of it.** Each memory is a small text file. Open it, edit it, delete it.
- **It stays small.** Your assistant gets a short table of contents at the start of every chat and looks up details only when it needs them. That keeps chats fast and cheap.
- **It guards against mistakes.** Passwords, API keys and paths that only work on your computer are blocked before they get saved.
- **It works with your team, too.** Share a set of rules through a private Git repository, so every teammate's assistant follows them.

---

## Get started (about 3 minutes)

You need **Node.js 20 or newer** and **Git**. To check, run `node -v` and `git --version` in a terminal.

**1. Create your memory folder**

```bash
npx @fabersep/memory setup
```

This creates `~/.faber/memory`, an empty folder for your notes, with its own Git history.

**2. Connect your AI assistants**

```bash
npx @fabersep/memory init
```

It finds the assistants on your computer and connects them. It keeps a backup of every file it touches, and you can undo it at any time with `npx @fabersep/memory init --undo`.

**3. Check that everything is connected**

```bash
npx @fabersep/memory doctor
```

You should see `PASS` lines. Each `WARN` or `FAIL` line comes with a one-line hint on how to fix it.

**4. Start a new chat in your assistant**

Tell it something about your project that it would otherwise get wrong, for example:

> *"In this project we run the tests with `make test`, never `npm test`. Please remember that."*

It should suggest saving this as a memory. (If it doesn't, ask it: *"Propose this as a memory."*)

**5. Approve what you want to keep**

```bash
npx @fabersep/memory review
```

You'll see each suggestion as a card. Press `a` to keep it, `e` to edit it first, `r` to throw it away, `s` to skip, or `q` to save and quit.

Now open a **new** chat and ask: *"How do I run the tests here?"* Your assistant answers `make test`, without you telling it again.

> **Already have notes?** If you keep rules in an `AGENTS.md`, a `CLAUDE.md`, Cursor rules or a folder of Markdown files, you can bring them in. They go to the same review step first. See [Importing existing notes](docs/guide.md#importing-existing-notes).

---

## A normal day with it

- **While you work:** nothing to do. Your assistant reads its short memory list at the start and looks things up as it goes.
- **When it learns something:** it suggests a memory. The suggestion waits in a "to review" box (`pre-memory`) and changes nothing yet.
- **When you have a minute:** run `npx @fabersep/memory review`. All your approvals are saved together, in one step.
- **Changed your mind?** Every memory is a file in `~/.faber/memory`. Edit or delete it like any file, then run `npx @fabersep/memory compile`. Git keeps the history.

A memory file looks like this:

```markdown
---
id: use-pnpm
type: rule
summary: Use pnpm, not npm, in this team's projects.
---

Run `pnpm install` and `pnpm test`. Never commit a package-lock.json.
```

---

## Common questions

**Doesn't my AI tool already have memory?**
Some do, but it stays inside that one tool, and the tool can write to it without asking you. FaberSEP Memory works across tools, and only you can approve what goes in. More in [Why FaberSEP Memory?](docs/why-faber-memory.md)

**Does it cost anything or send my data anywhere?**
No. It's free and open source (Apache-2.0), and it runs on your computer. Your notes go only where you push them yourself, for example to a private team repository.

**Can I use it on my phone?**
Not directly yet. If you control a computer or server from your phone (for example with Claude Remote Control), memory works in that session.

**How do I update or remove it?**
`npx @fabersep/memory@latest --version` fetches the newest version and prints its number. `npx @fabersep/memory init --undo` disconnects your assistants and leaves your notes in place. See [Updating and cleaning up](docs/guide.md#updating-and-cleaning-up).

**Something went wrong.**
Run `npx @fabersep/memory doctor` first. Then check [Troubleshooting](docs/troubleshooting.md) or [open an issue](https://github.com/fabersep/memory/issues).

---

## Going further

- **[User guide and reference](docs/guide.md):** how it works inside, team setup, importing, every command, the MCP tools and where files live.
- **[Why FaberSEP Memory?](docs/why-faber-memory.md):** comparisons with built-in memory and vector databases, and why the design keeps prompt caching cheap.
- **[Troubleshooting](docs/troubleshooting.md):** every warning, explained.
- **[Contributing](CONTRIBUTING.md)** and **[Changelog](CHANGELOG.md)**.

FaberSEP Memory is part of [FaberSEP](https://github.com/fabersep), open-source tools that help AI coding assistants work with more discipline.

## License

[Apache-2.0](LICENSE)
