# Contributing to FaberSEP Memory

Thanks for helping. Bug reports, doc fixes and pull requests are all welcome.

## Report a bug

[Open an issue](https://github.com/fabersep/memory/issues) with:

- what you ran and what you expected;
- the output of `npx @fabersep/memory --version` and `npx @fabersep/memory doctor --json` (check it for anything private before you paste it);
- your OS and Node.js version.

## Make a change

```bash
git clone https://github.com/fabersep/memory.git
cd memory
npm install
npm test
```

- **Specs come first.** Behavior is defined in `docs/features/<NN>-<slug>/prd.md` and `acceptance_criteria.md` ([FaberSEP Spec](https://github.com/fabersep/spec)). A change in behavior updates its spec in the same pull request; a new capability gets a new feature folder.
- **Zero runtime dependencies and no native addons.** Only `devDependencies` are allowed.
- **Keep L0 deterministic.** Nothing time-, machine- or count-dependent may reach the compiled `MEMORY.md`.
- **Tests:** `npm test` builds with `tsc` and runs `node --test`. Add a test for every fix or scenario.
- **Docs:** the README is for non-technical users and tells the story; technical detail goes in `docs/guide.md`. Add a line to `CHANGELOG.md` under the unreleased version.

## License

By contributing you agree that your contribution is licensed under [Apache-2.0](LICENSE).
