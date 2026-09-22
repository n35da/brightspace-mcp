# brightspace-mcp

A read-only MCP server that gives Claude (or any MCP-compatible client)
direct access to your Brightspace (D2L) courses: course content,
assignments, quizzes, grades, announcements, and file downloads. It calls
D2L's own JSON API directly instead of driving a browser page by page.
Works at **any institution** that runs Brightspace, not just one school.

I built this to manage my own Brightspace coursework, then generalized it
so it works at any Brightspace school. It optionally pairs with a
[web calendar app](#optional-companion-web-calendar) I also built (see
below).

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [How this works (and what it does with your login)](#how-this-works-and-what-it-does-with-your-login)
- [Which courses show up](#which-courses-show-up)
- [Tool reference](#tool-reference)
- [Optional companion: web calendar](#optional-companion-web-calendar)
- [Automated re-login](#automated-re-login)
- [When it stops working](#when-it-stops-working)
- [Tests](#tests)
- [Security & privacy](#security--privacy)
- [Reset / revoke access](#reset--revoke-access)

## Features

- **Course browsing**: list your enrolled courses, walk a course's full
  content tree (modules, lecture slides, syllabus links), and download any
  file-type content topic straight to disk. Files under 10 MB are also
  embedded directly in the tool response, so Claude can read them right
  away without a separate filesystem-permission prompt.
- **Assignments & grades**: see every dropbox folder's due date, points,
  and instructor-provided attachments; check whether you've already
  submitted and download your own submitted files; read your quiz list and
  your actual grade values.
- **Announcements & due dates**: recent course announcements, plus a single
  "what's due across every course in the next N days" tool.
- **Persistent per-class notes**: each course gets a markdown notes file
  (Class Information / Schedule / Notes, each individually timestamped) so
  context survives across chat sessions instead of being re-derived from
  scratch every time, while staying explicit about what's a cache versus
  what's live.
- **Automatic session recovery**: when your D2L session expires, the
  server re-logs in headlessly using your browser's saved SSO trust (or
  saved credentials as a fallback) before ever bothering you about it.
- **Optional calendar export**: compile deadlines (including ones only
  found in a syllabus or lecture slide, not in D2L's own dropbox/quiz data)
  into a schema-validated JSON file for the companion web calendar.
- **Works anywhere Brightspace runs.** One `d2lBaseUrl` in your config, set
  once via the setup wizard. Nothing else here assumes a specific school.

## Quick start

```bash
npx @n35da/brightspace-mcp setup
```

This will:
1. Ask for your school's Brightspace URL (e.g. `https://d2l.myschool.edu`) and optional course-code filters.
2. Open a real, visible browser window for you to log in with your school SSO and approve any 2FA yourself. This script never sees your password unless you explicitly opt in to saving it (see [Automated re-login](#automated-re-login)).
3. Automatically add `@n35da/brightspace-mcp` to Claude Desktop's config, wherever your OS/install keeps it.

Then fully quit and relaunch Claude Desktop. No cloning, no manual JSON editing, no local install required.

If you'd rather run from source (e.g. to read or modify the code):
```bash
git clone https://github.com/n35da/brightspace-mcp
cd brightspace-mcp
npm install
npx playwright install chromium
node bin/setup.mjs
```

### Manual Claude Desktop config

If the setup script couldn't find your Claude Desktop config, or you'd prefer
to wire it in manually, add this under `"mcpServers"`:

```json
{
  "mcpServers": {
    "brightspace": {
      "command": "npx",
      "args": ["-y", "@n35da/brightspace-mcp"]
    }
  }
}
```

Config file locations:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Then fully restart Claude Desktop.

## How this works (and what it does with your login)

Brightspace doesn't hand out official developer API keys to students, so
there's no "proper" OAuth app registration path here. What *does* work, and
is confirmed by D2L's own community forum: a logged-in student's session can
call the same JSON endpoints (`/d2l/api/lp/...`, `/d2l/api/le/...`) that the
Brightspace website itself calls, because the account can already do
everything from the web interface. Here's what happens:

1. `auth.mjs` opens a real, visible Chromium window at your school's
   Brightspace instance, backed by a **persistent browser profile** at
   `~/.msu-d2l-mcp/browser-profile` (this directory keeps its original name
   from before this project was generalized beyond one school; it's not
   specific to MSU or any other institution). **You** type your school SSO
   password and approve any 2FA yourself. It only reads two session cookies
   (`d2lSessionVal`, `d2lSecureSessionVal`) and a CSRF token off the page
   once you're already logged in. Tick any "Keep me signed in" / "Remember
   me" option your school offers; that trust is stored in the profile, and
   it's what lets step 4 stay automatic for weeks.
2. Those get saved to `~/.msu-d2l-mcp/session.json` (owner-readable only).
   `auth.mjs` also offers to save your school username and password to
   `~/.msu-d2l-mcp/credentials.json` (plain JSON, 0600) so automated
   re-login can still get in after the SSO trust expires. Declining is
   fine. See [Automated re-login](#automated-re-login) for what that
   changes.
3. `server.mjs` exchanges that for a short-lived Bearer token by POSTing to
   `/d2l/lp/auth/oauth2/token` (Brightspace's own internal "mint" endpoint),
   then calls the documented D2L REST API with it. Nothing is ever posted,
   submitted, or changed in Brightspace. Every tool here is a `GET`.
4. When the D2L session expires (on the order of hours), the server fixes
   itself: it relaunches Chromium **headlessly** with the same browser
   profile (`lib/reauth.mjs`) and rides the saved SSO trust straight to a
   fresh D2L session, no password, no 2FA, no prompt. If the profile's
   trust is gone but credentials were saved, it falls back to typing them
   into your school's login form. If your school then issues a 2FA
   challenge anyway, it stops and the `reauthenticate` tool reports
   failure. At that point (and only then) a human runs
   `npx @n35da/brightspace-mcp setup` again.

This is unofficial. It's not sanctioned by D2L or your school, it's just
using your own login the way the website already does. It's read-only and
scoped to your own data, but if that's a line you'd rather not cross, don't
set this up.

## Which courses show up

`list_courses` (and everything built on it, like `get_upcoming_due_dates`)
only returns courses matching `config.json`'s `courseCodes` list.
Brightspace's "active enrollment" flag doesn't mean "current semester." It
stays true for old courses too, so without this filter you'd see every
course you've ever taken.

Use `npx @n35da/brightspace-mcp setup` to configure course codes each semester
(the normal way). If you prefer to edit `config.json` manually, it contains:
```json
{
  "d2lBaseUrl": "https://d2l.myschool.edu",
  "courseCodes": ["CSE404", "STT404"]
}
```

Course code matching is a substring match, ignoring spaces/dashes/case, so
`"CSE404"` matches a D2L code like `CSE-404-730-FS26`. Clear the array to
see every enrollment Brightspace returns, which is useful once to check what
your real course codes look like.

## Tool reference

| Tool | What it does |
|---|---|
| `reauthenticate` | Manually trigger a headless re-login and refresh the saved session. |
| `list_courses` | List your enrolled courses (respecting `courseCodes`), with each `orgUnitId`. |
| `get_course_content` | Walk one course's full content tree (modules, lecture materials, syllabus links), flattened with module paths. |
| `download_content_file` | Download a file-type content topic (syllabus PDF, slides) to disk, embedding its contents directly in the response when it's small enough. |
| `get_assignments` | List a course's dropbox folders: due dates, points, instructor attachments, your own submission status. |
| `download_assignment_attachment` | Download an instructor-provided attachment on a dropbox folder (starter code, instructions), embedded directly when small enough. |
| `download_submission_file` | Download a file you previously submitted to a dropbox folder, embedded directly when small enough. |
| `get_quizzes` | List a course's quizzes with dates and active status. |
| `get_grades` | Read your own grade values for every graded item in a course. |
| `get_announcements` | Recent announcements/news posts for a course. |
| `get_upcoming_due_dates` | Everything due across every enrolled course within a given window, soonest first. |
| `get_class_notes` | Read a course's persistent markdown notes file. |
| `save_class_notes` | Write/update one section of a course's persistent notes file. |
| `export_calendar_json` | Build and save a schema-validated JSON export for the [optional companion calendar](#optional-companion-web-calendar). |

## Optional companion: web calendar

I built a web calendar app at
[n35da.com/tools/d2l-calendar](https://n35da.com/tools/d2l-calendar) to
pair with this: a persistent calendar with a month view, countdowns, and
manual editing that survives across sessions and re-imports. It's entirely
optional. Nothing in this MCP depends on it, and every tool works
completely on its own without it.

To use it, ask Claude to compile your deadlines. It'll use
`get_assignments`, `get_quizzes`, the syllabus, and any other course
document it can find, since real due dates are often only posted in a
syllabus or lecture slide and never show up in D2L's own dropbox/quiz data.
Then call the `export_calendar_json` tool with what it found. That writes
a JSON file to `exports/` matching the calendar app's schema, validated and
cross-checked before it's saved so the file can't be subtly malformed.
Import that file at the URL above to get a working calendar. Re-running the
export and re-importing later keeps your completion state, since events are
matched by a stable id.

It's a separate account system from Brightspace. No D2L credentials or
session data ever reach it, only whatever deadlines you choose to export.

## Automated re-login

When a tool call hits an expired session, the server tries to recover on
its own before reporting anything:

1. **Silent SSO ride**: headless Chromium reuses `browser-profile`, where
   your school's "keep me signed in" and "remember me" trust live. Usually
   this is all that's needed, and it works for as long as your school
   honors that trust (weeks, if you ticked the boxes during setup).
2. **Saved credentials**: if the SSO trust is gone and `credentials.json`
   exists, `lib/reauth.mjs` fills in the school login form. If 2FA
   challenges anyway, automation stops there. No machine can approve 2FA
   for you.
3. **Manual fallback**: the `reauthenticate` tool reports why it failed,
   and a human runs `npx @n35da/brightspace-mcp setup` again.

The `reauthenticate` tool exists for the agent to retry on purpose (e.g.
after you've fixed something); ordinary tool calls attempt recovery
automatically, and after one failed attempt the server stops burning time
on it per call. Credentials and session state never appear in tool output.
The agent only sees success/failure and a reason string.

`credentials.json` is deliberately plain JSON (your call), so treat it like
a password manager export: anyone who can read `~/.msu-d2l-mcp/` as your
user account has your school password. Delete it any time; `auth.mjs` will
just offer to save it again next manual login.

## When it stops working

- **`reauthenticate` returns `"reason": "duo"` or repeated failures**: run
  `npx @n35da/brightspace-mcp setup`, log in, tick any "remember me" option, and
  answer `y` to saving credentials.
- **A course 403s on assignments/quizzes**: normal for past-semester or
  not-yet-released content; the tool just skips it.
- **Brightspace changes its cookie names or page structure**: `auth.mjs` /
  `lib/reauth.mjs` will fail loudly rather than silently save garbage; tell
  Claude and it can update the extraction logic.

## Tests

```bash
node test/smoke.mjs                # server boots, all tools registered
node test/config.test.mjs          # config.json loading and validation
node test/auth-baseurl.test.mjs    # URL validation
node test/claudeConfig.test.mjs    # Claude Desktop config path detection and merging
node test/setupHelpers.test.mjs    # setup.mjs helper functions
node test/deadlinesExport.test.mjs # export_calendar_json schema validation
node test/content.test.mjs         # content-tree walking against a fake D2L
node test/credentials.test.mjs
node test/reauth.test.mjs          # headless login vs a fake Brightspace (password/SSO/2FA paths)
node test/autoheal.test.mjs        # full MCP: expired session auto-heals mid-call
node test/authflow.test.mjs        # the real auth.mjs script, headless, end-to-end
node test/mock-d2l.mjs             # d2lClient minting/expiry logic
```

All of these run against local fakes in temp dirs. They never touch the
real `~/.msu-d2l-mcp` or the network.

## Security & privacy

- **Read-only.** Every D2L API call this project makes is a `GET`. Nothing
  is ever posted, submitted, or changed in Brightspace.
- **Your data stays on your machine.** Session cookies, tokens, and
  (optionally) your saved password live only in `~/.msu-d2l-mcp/`, never
  transmitted anywhere except directly to your own school's Brightspace
  instance.
- **The optional calendar export** sends only what you explicitly export
  (deadlines, course names, grade weights) to a separate service with its
  own account system, never your Brightspace credentials or session.

## Reset / revoke access

Delete `~/.msu-d2l-mcp/` (Windows: `C:\Users\<you>\.msu-d2l-mcp\`) to wipe
the saved session, browser profile, and saved credentials. There's no
separate "app" registered anywhere to revoke. It's just your own browser
session, which you can also kill by logging out of Brightspace elsewhere or
changing your school password.
