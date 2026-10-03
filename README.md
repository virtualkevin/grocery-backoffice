# grocery-backoffice

## Entire

Browse this repository's trails and captured sessions at
[Entire](https://entire.io/gh/virtualkevin/grocery-backoffice).

After installing the [Entire CLI](https://github.com/entireio/cli#quick-start),
run these commands from your checkout:

```sh
entire login
entire enable --agent codex --absolute-git-hook-path --telemetry=false
entire status
```

Open `/hooks` in Codex to review and approve the installed Entire hooks, then
start a new session. For linked Git worktrees, the original checkout must also
contain `.codex/hooks.json`; run the enable command there if needed.

Work on a branch, commit, and push normally. Entire captures agent sessions
through its hooks and syncs checkpoints when you push. Create a trail for the
current branch with:

```sh
entire trail create --title "Describe the work" --type task --base main
entire trail show
```

Use `entire doctor` to check the setup. Local settings, logs, and temporary
session data are ignored by `.entire/.gitignore`.
