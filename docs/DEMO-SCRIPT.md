# Guided demo script

Version for the P8 release candidate on `phase/p8-launch-prep`. Written 2026-11-09 (America/New_York). Use it for a live walkthrough, an interview screen share, or the video in the shot list at the end.

The demo needs no sign-up, no account and no outside provider. Every name and number is synthetic. Sources are simulators, document reviews are labeled fixtures and automation runs are recorded as Simulated, so the script works the same with Salesforce, Zapier, Google and every AI provider switched off (P7-E, P8-E).

## Before you start

- Open the app's start page in a fresh browser window. Locally that is `http://localhost:8787` after the steps in `START-HERE.md`. There is no hosted URL yet.
- Use a private window if you ran the demo before, so you get a new workspace instead of reusing the old one.
- If the screen is shared, zoom the browser to 110 or 125 percent so the labels are readable.

## The five-minute run

Times are a budget for a person talking while clicking. They add up to about 4 minutes 30 seconds, which leaves room for one question.

| # | Time | Say | Do | What the viewer should notice |
|---|---|---|---|---|
| 0 | 0:00 to 0:20 | "This is an operations command center for a fictional services company. Everything you'll see is synthetic." | On the start page, press **Launch Guided Demo**. | No sign-up. A private workspace appears in a second or two. The banner says the demo is simulated. |
| 1 | 0:20 to 0:35 | "Each visitor gets an isolated copy of the same scenario. The checklist tracks my own actions, read back from the database." | On **Guided demo**, press **Use the Manager role**. | The checklist shows 1 of 5 done. The role is a simulation control, not a login. |
| 2 | 0:35 to 1:10 | "First, a case: the unit of work an operations team tracks." | Step 2's **Open Cases**. Press **New case**, type a title, press **Create case**. | The new case opens with its checklist and an activity history that already holds a `case.created` event. |
| 3 | 1:10 to 2:00 | "The CRM and ERP disagree about a customer. The sync finds it, but it doesn't decide anything." | Menu **Guided demo**, then step 3's **Open Integrations**. On **ERP Simulator**, choose **Customer renamed** and press **Run simulated sync**. Then open **Reconciliation**, set Status to Open and open the **Name mismatch**. | Both source values sit side by side, labeled Simulated. No customer record changed. |
| 4 | 2:00 to 3:10 | "A document review suggests checklist changes. Every field points at the page and text it came from, and a person decides." | Menu **Guided demo**, step 4's **Open Cases**. Open an **Intake** case, pick a document ending in *(complete)* in **Attach a fictional document**, press **Attach**, then **Request review**. Read one cited field, then press **Reject** (or **Accept**). | The label says *Deterministic demonstration fixture*. No language model is called. A reject changes nothing on the case. |
| 5 | 3:10 to 3:50 | "Approval is the one place a decision changes state. It writes audit history and starts an automation, which here is labeled Simulated." | Menu **Guided demo**, step 5's **Open Cases**. Open a **Ready** case and press **Approve**. | The status chip turns Approved. |
| 6 | 3:50 to 4:30 | "The recap is built from the records, and it separates what happened from what was simulated and what was measured." | Menu **Guided demo**. Read the **Recap**. Optionally open **See the automation runs** to show the Simulated run. | The server-timed duration, the counts, and the three honest headings. Nothing claims delivery. |
| 7 | 4:30 to 4:45 | "And it starts over cleanly." | Press **Reset Demo**, then **Confirm reset**. | The checklist is back to 1 of 5 in a fresh workspace. |

If there's time for one more screen, open **Engineering evidence** from the start page. It lists the latest test results and what is still pending, with no session needed (E2E-28).

## Keyboard-only run

Every step works without a mouse. Tab reaches **Launch Guided Demo** second, after the skip link. On **Guided demo**, each step's link reads as "Open Cases for step 2" and so on. **Reset Demo** opens a confirm button that takes focus; Enter confirms and focus moves to the **Your checklist** heading. `tests/e2e/guided-demo.spec.ts` checks this path on every run.

## If something goes wrong

| Symptom | What to say and do |
|---|---|
| "Starting your demo workspace" stays up | The database may be waking. After 8 seconds a **Retry** button appears, and after 15 seconds a link to the written walkthrough on the evidence page. |
| "The demo is full right now" | The demo has a capacity cap. Open **Engineering evidence** and walk through the written steps instead. |
| "Progress couldn't load. The steps below still work." | The checklist still links to each step. Press **Retry** when ready. Nothing in the demo depends on the progress call. |
| A step stays "To do" after you did it | Press **Refresh progress**. The page reads progress again when you come back to it, but not while it is open. |
| You switched to Viewer by mistake | Use the role selector at the top of any app page, or **Use the Manager role** on the checklist. |

## Local timing evidence

These are runs on this machine, not a person's timing. A first-time interviewer's run has not happened yet.

| Run | Result | Where |
|---|---|---|
| Automated scripted run of all five steps through the screens, recap and reset, Chromium desktop and Pixel 7 sizes | See `docs/evidence/P8.1/timed-run.txt` | `tests/e2e/guided-demo.spec.ts` |
| Same, Playwright WebKit desktop and iPhone 15 sizes | See `docs/evidence/P8.1/webkit-run.txt` | same |
| Server-timed duration from launch to the last step | Shown in the recap of every run | `GET /api/v1/demo/progress` |

A machine runs the steps in seconds, so these runs prove the path works end to end. They do not prove a person finishes in five minutes. That check (P8-A) needs one real first-time visitor, timed, with the result written into `docs/reports/P8.1.md`.

## Video shot list

The PRD asks for a 2 to 3 minute video and a fallback recording. Neither exists. Recording needs Jose's screen and voice, and publishing it is a stop point, so this is the plan only.

**Setup.** 1440 by 900 browser window, light theme (the **Light theme** button), zoom 110 percent, a fresh private window, notifications off. Record locally or on staging; the banner reads "Simulated demo" either way. No real names, emails or tabs in view.

| Shot | Length | Screen | Voice-over (draft) |
|---|---|---|---|
| 1 | 0:00 to 0:10 | Start page | "OpsBridge AI is a portfolio project: an operations command center for a fictional services company." |
| 2 | 0:10 to 0:20 | Press Launch, the checklist appears | "There's no sign-up. Each visitor gets a private copy of a synthetic scenario." |
| 3 | 0:20 to 0:40 | New case, title, Create case, activity list | "A case is the unit of work. Every change lands in an append-only audit history." |
| 4 | 0:40 to 1:05 | ERP Simulator, Customer renamed, sync, then the Name mismatch with both values | "The CRM and the ERP disagree about a customer. The sync shows both values and changes nothing. A person decides." |
| 5 | 1:05 to 1:40 | Attach a fixture, Request review, the cited fields table, Reject | "Document review suggests changes, and every field cites its page and text. This demo uses labeled fixtures; no model is called. A reject changes nothing." |
| 6 | 1:40 to 2:00 | Approve a Ready case, then Automations showing a Simulated run | "Approval writes the audit trail and starts an automation. Here delivery is recorded as Simulated, never as sent." |
| 7 | 2:00 to 2:20 | Recap, slowly scrolled | "The recap comes from the records. It says what happened, what was simulated, and that nothing here is a measured business result." |
| 8 | 2:20 to 2:35 | Engineering evidence page | "The evidence page lists the test results and what's still pending, like hosted timings and live integrations." |
| 9 | 2:35 to 2:45 | Reset Demo | "And it resets cleanly." |

**Fallback recording.** Shots 2 to 7 with no voice, as a silent screen capture, for when the live demo can't load during an interview.

**Rules for the video.** Don't say or caption "live", "integrated with Salesforce", "AI-powered" without "fixture", "production", "customers" or any adoption or savings figure. Don't show the owner `/admin` area, the terminal, `.dev.vars` or a password manager. Jose reviews the final cut before it is published anywhere (P7 list item 14).
