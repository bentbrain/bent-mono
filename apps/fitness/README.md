# Fitness

A TanStack Start app for strength sessions, runs, food and bodyweight. Each invited account has private cloud storage in a dedicated Postgres database. Shared design tokens and controls come from the root workspace.

## Development

Use the root Bun version. Link the `fitness` Vercel project, provision a dedicated Neon development database, then pull the development environment into `.env.local`. Add the Clerk TanStack Start keys and the server-only `FITNESS_ALLOWED_EMAILS` list. Each address must match the account's verified primary email. An empty invitation list denies access.

```sh
bun run db:migrate
bun run dev
```

Run commands from `apps/fitness`. `.env.example` lists the configuration keys. Keep development and production databases and Clerk applications separate. Claim an accountless Clerk development application through Clerk before configuring production.

The app checks the signed-in account and invitation on every server operation. SQL queries include the authenticated owner ID. Record revisions detect conflicting edits, and per-account request receipts make retries idempotent. Completed workouts retain their exercise prescriptions and results. A correction is a separate record that replaces or hides one completed workout in History, the week view and weight suggestions; the original stays in the account and its export, and removing the correction restores it. Training dates cannot be later than the account's current day in its timezone. Device drafts queue cloud writes and show saving, pending, failure and conflict states. Export pending changes before choosing a cloud version in a conflict.

## Week, exercises, food and progress

The app has four sections: Week, Exercises, Food and Progress. Settings opens from the gear in the header.

Week shows the seven days of the selected week. Each day is marked done, planned, not recorded or rest, with its routine or run. Select a day to see what it holds without starting anything: the plan, its exercises with a How to guide for each, and the actions for that day. Start workout begins today's session from Week or from the plan. The week totals compare completed strength sessions and runs with the plan and show the day's food.

Use Reorganise week to manually move a planned workout or run to another day in the selected week. The two days swap, including rest days. Past days and days with recorded or started activity are unavailable in the move panel. The repeating schedule and recorded results stay unchanged. Dated strength plans keep their routine details from the move. Reset week to repeating plan removes that week's adjustments.

Start with the included A/B dumbbell templates. Edit the training days, start date, introduction and routines in Repeating week, reached from Week or Settings. It previews the next two weeks before you save. Strength days take turns through your routines in calendar order from the plan start date, so a missed day keeps its routine. The introduction uses up to two sets per exercise for the configured number of weeks. Weights mean one dumbbell. Rows and split squats record both sides; planks record seconds. Progression suggestions require all prescribed sets to reach the top of the range with control and at least two reps in reserve. Add confirmed dumbbell sizes in Settings to get suggestions based on available weights.

Open a plan to see last time's results, the suggested load and an estimated duration. A future plan offers Do this workout today, and a past plan offers Log workout for that date or Do this workout today. Starting creates a recoverable draft and starts the elapsed timer.

Typed set values stay on the device until you leave the set, press Done or Skip, leave the page or reopen the draft, then save to your account in one change. Each open tab keeps the fields it typed, so values held in another tab survive a reload. Invalid text stays in its field with a message. Mark each set Done or Skip it to finish; skipped sets do not count towards a weight increase. Rest starts when you mark a set Done, or you can choose a duration to start a new rest interval and skip it from the rest controls. When rest ends, the timer shows Rest done, names the next set, announces it to screen readers and vibrates where the device supports it. Both timers use saved timestamps and continue across navigation and reloads. Every screen, plan and active workout has its own URL and supports browser Back and Forward.

Exercises lists each included movement with a picture, how it is measured and the routines that use it. Each guide has setup instructions, form cues, how to record the exercise, your last result, a YouTube tutorial and a six-panel illustration showing the movement from two angles. The same guide opens over a plan or an active workout from How to. Open an illustration at full size to inspect the positions. The illustrations are AI-generated references. Read the written instructions and watch the demonstration before trying a new movement. Start light and stop if a movement hurts.

Food shows the day's calories and protein against your targets, with what is left. Saved meals add to the selected day in one tap. Entries can be edited and removed, and a seven-day strip compares daily calories with the target. Move between days with the arrows or the date picker.

Progress counts completed sessions against the plan for recent weeks. Strength cards compare the first and latest best completed set for each exercise, kept separate by reps or seconds and by sides. Bodyweight shows the average of the latest seven weigh-ins and the change from the seven before. Sessions lists completed workouts and runs: correct, remove and restore workouts, and edit or remove runs. A correction editor that finds a newer saved version keeps your typed results and asks whether to load the saved version or save your changes over it. Bodyweight keeps one current value per date; the chart shows the latest 60 recorded dates, a rolling average of up to seven weigh-ins and your highest and lowest values in view. Compare trends over several weeks when adjusting food targets.

## Assistants and agents

Fitness runs an MCP server at `/api/mcp` on the app's origin. ChatGPT, Claude and other MCP clients can use it to read and edit food, saved meals, bodyweight and runs, and to read planned and completed training. Tell an assistant what you ate and it logs each item with estimated calories and protein, then reports the day's totals. Ask it to save a meal and the meal appears in Food for one-tap logging.

| Tool                        | What it does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `fitness_get_day`           | One day's meals with IDs, totals and what is left of the targets, weigh-in, plan, workouts, runs |
| `fitness_get_history`       | Daily calories, protein, weigh-ins, workouts and runs for up to 62 days                          |
| `fitness_list_saved_meals`  | Saved meals with IDs, calories and protein                                                       |
| `fitness_add_meals`         | Logs one or more meals to a day                                                                  |
| `fitness_update_meal`       | Changes a meal's name, calories, protein or date                                                 |
| `fitness_add_saved_meals`   | Saves one or more meals for one-tap logging, skipping meals already saved                        |
| `fitness_update_saved_meal` | Changes a saved meal's name, calories or protein                                                 |
| `fitness_delete_entries`    | Removes meals, saved meals, runs or weigh-ins by ID                                              |
| `fitness_log_weight`        | Records the day's bodyweight in kg or lb, replacing an earlier value for that date               |
| `fitness_log_run`           | Records a run on today or an earlier date                                                        |

Dates use the account timezone, and a tool without a date uses today. Read results include each meal, saved meal, run and weigh-in's ID and revision. Updates and deletions send the revision they read, and fail if the entry has changed since. Every change carries a `requestId` chosen by the assistant. Retrying the same call with the same ID returns the first result without saving again, and reusing an ID for different input fails. Each tool call saves its changes and its result in one transaction, so a failed call saves nothing. Strength workouts are read-only here; record and correct them in the app.

To connect an assistant, add `https://fitness.bent.build/api/mcp` as a custom MCP app or connector. The client opens the Fitness sign-in, where you sign in with your invited account and approve access. For scripts and local agents, create an API key under Manage account → API keys and send it as `Authorization: Bearer <key>`. Every request checks the token and the invitation list. OAuth tokens must name the MCP endpoint as their audience. Browser session cookies do not authorize MCP requests.

Access follows the token's scopes. `fitness:read` lists the read tools and `fitness:write` lists the tools that add, change and remove entries. Write results include the day's totals, the other saved meals and replaced values only when the token also has `fitness:read`; otherwise they confirm what the call saved. Adding saved meals skips a meal already saved with the same name, calories and protein when the token has `fitness:read`; without it, the call saves each distinct meal it lists. A token with neither scope gets `403 insufficient_scope`. An API key with scopes follows the same rules. An API key without scopes, such as one created under Manage account, has read and write access.

`FITNESS_MCP_URL` sets the MCP endpoint and defaults to `https://fitness.bent.build/api/mcp`. Set it to the local address in development, for example `http://127.0.0.1:3025/api/mcp`. Configure each Clerk instance with these settings:

- Add the MCP endpoint under Agents → MCP servers. Clerk then issues tokens with that audience.
- Create the `fitness:read` and `fitness:write` custom scopes under OAuth applications → Scopes. Describe `fitness:read` on the consent screen as reading meals, saved meals, bodyweight, runs, planned training, workouts with their sets and notes, and your goal and calorie and protein targets. Describe `fitness:write` as adding, changing and removing meals, saved meals, bodyweight and runs.
- Turn on dynamic client registration for OAuth applications. Allow `openid`, `profile`, `email`, `fitness:read` and `fitness:write` for dynamically registered clients, or leave the allowed scopes unrestricted.
- Set the OAuth default scopes to `openid`, `profile`, `email`, `fitness:read` and `fitness:write`. Clerk assigns the default scopes to a client that registers without requesting any. ChatGPT registers that way, then requests `openid` because Clerk advertises it.
- Turn on API keys to create keys for scripts.

`/.well-known/oauth-protected-resource` names the Clerk Frontend API as the authorization server. `/.well-known/oauth-authorization-server` mirrors Clerk's metadata for clients that look it up on the app's origin.

## Equipment photos and exports

Settings accepts up to 20 private JPEG, PNG or WebP equipment photos, each up to 2 MB. The server checks file signatures and ownership, and serves photos with private, no-store headers. Account export includes settings, entries, workout history, corrections and photo bytes. The download starts only after the complete export has loaded. Store exports privately.

Add the site to your home screen through your mobile browser's share menu. The manifest opens it as a standalone app. Reconnect to load cloud data and finish pending saves.

## Feedback toolbar

The Fitness project at `https://toolbar.bent.build` allows the canonical app origin and local development origins. `.feedback-toolbar.json` contains its public installation settings. The shared layout loads the hosted embed. Account data, workout values, food, bodyweight and settings use the toolbar's redaction and privacy attributes.

## Checks and release

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bun run knip
bun run test:browser
```

`FITNESS_TEST_DATABASE_URL` enables the Postgres integration tests. Use a disposable database or the dedicated development database. The tests create unique synthetic account IDs and remove only their own records. CI supplies its disposable Postgres service. Public browser checks verify the configuration boundary without provider credentials. Authenticated provider checks require a Clerk development application and invited synthetic accounts.

Run the root public-source and workspace checks before publishing. Vercel uses the app directory, Node 24, the pinned Bun bootstrap and the root lockfile. Git-triggered builds are disabled; the repository's `release:vercel` command creates and promotes production candidates with independent review, security checks and `Release qualification`. Configure the dedicated production database and invited accounts before runtime qualification. Apply the schema to that database through the reviewed release procedure.
