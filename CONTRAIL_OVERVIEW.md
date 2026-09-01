# Contrail

**An AI harness built for Salesforce work.**

Contrail lets an AI assistant work *inside* a Salesforce org the way an experienced
admin or architect would — reading metadata, tracing dependencies, drafting changes,
and deploying them — while keeping a human firmly in control of anything that writes.
It ships as a plugin for Claude: a local server that connects to your orgs, plus a
set of skills that teach the assistant how Salesforce actually behaves.

---

## The problem

General-purpose AI coding assistants are good at code and bad at Salesforce.

Salesforce isn't a codebase you can just read top to bottom. It's a live, stateful
platform where the "source" is thousands of interlocking metadata components spread
across APIs, where a single field change can ripple through flows, permission sets,
and reports, and where the same action behaves differently in a sandbox than in
production. Ask a generic assistant to "add a field and update the flow that uses it"
and it will confidently invent component names, miss the permissions that have to
travel alongside the field, and — most dangerously — treat deploying to a customer's
production org as casually as saving a file.

For someone who does Salesforce delivery for a living, that gap is the whole game.
The interesting, time-consuming work — understanding an unfamiliar org, figuring out
what a change will break, building metadata correctly the first time — is exactly
what a generic assistant can't be trusted to do. And the one thing you can never get
wrong, an unauthorized or careless write to a client org, is exactly the thing a
generic assistant has no concept of.

Contrail exists to close both gaps at once: give the assistant real, structured
understanding of an org, and make destructive mistakes structurally impossible rather
than merely discouraged.

---

## What it is

Contrail is a harness — the connective layer between an AI assistant and Salesforce —
built around three ideas.

**1. It understands the org, not just the API.**
Contrail builds and maintains a local snapshot of an org's metadata: full-text
searchable, with a dependency graph so you can ask "what depends on this field?" and
get a real answer. The assistant can search components, diff two versions of the same
artifact, diff two entire orgs against each other, retrieve metadata, run SOQL, read
debug logs, and inspect flow errors — all through a vocabulary that matches how
Salesforce professionals actually think about their work.

**2. Every write requires a human.**
This is the core invariant, and it is not configurable. Any change that modifies an
org — deploying metadata or writing data — follows a strict two-step path: the
assistant *proposes* a change, a human reviews it and reads a one-time confirmation
code shown **only** on a local approval page in their own browser, and the change
executes only when that code is supplied. The code never appears in anything the
assistant can see. Even an assistant that has been manipulated or has simply
misunderstood the task cannot approve its own writes — the approval lives entirely
outside its reach, in front of a person.

**3. Access is granted deliberately, in layers.**
A human decides, per connection, what the assistant is even allowed to attempt —
reading metadata, writing metadata, reading data, writing data, reading diagnostics —
using a small set of explicit permission grants. Those grants are enforced by the
server on every call, independent of anything the assistant claims or intends. Read a
lot, write nothing, is the default posture.

Together these turn "an AI with access to my Salesforce org" from a reckless idea into
a controlled one.

---

## What it can do today

Phase 0 is a working engine, dogfooded end-to-end against a real development org:

- **Connect** to multiple orgs (sandbox or production) over standard OAuth, with
  refresh tokens held in the operating system's keychain — never in plain files.
- **Map** an org into a searchable, dependency-aware snapshot.
- **Investigate** — search and describe metadata, trace what a change would affect,
  diff artifacts and whole orgs, query records, and read logs and flow errors.
- **Change, safely** — validate and deploy metadata, and create/update/delete data,
  each gated behind the human confirmation flow above.
- **Migrate data at scale** — load ordered CSV files (accounts, then the contacts
  that reference them) straight into an org through Salesforce's Bulk API, with the
  whole plan on one approval page and the rows travelling file → org, never through
  the assistant. Failed rows come back as files to fix and re-run.
- **Guide the work** — bundled skills encode hard-won Salesforce judgment, like
  "permissions have to ship alongside the components that need them" and the quirks of
  how flows deploy, so the assistant builds things the way a careful practitioner
  would.

It runs the same on Windows and macOS, and is packaged so a teammate can install it
by handing their own assistant a short instruction file.

---

## How it was built

The emphasis was less on writing code quickly and more on being *sure* it was right,
because the whole value proposition is trust.

- **Spec-first.** The scope, the safety invariants, and the milestones were written
  down before implementation, and treated as the contract the build had to satisfy.
- **Adversarial review at every milestone.** Rather than a single self-check, each
  milestone was reviewed by multiple independent passes looking for distinct classes
  of problem — security holes, correctness bugs, spec violations, Salesforce-API
  misuse — and every finding was verified before being accepted or dismissed. This is
  how the most important bug was caught: an early version leaked the approval URL to
  the assistant on an error path, which would have let it read its own confirmation
  code. The safety model only holds because it was actively attacked.
- **Live dogfooding, including the scary parts.** The engine was exercised against a
  real org through the full lifecycle — connect, explore, deploy custom objects and a
  flow, trigger that flow, set field-level security, write and delete records, and
  tear it all back down — so that the guarantees are demonstrated, not just asserted.

---

## Why it's interesting

Contrail sits at an intersection that's genuinely hard to get right: deep,
domain-specific platform knowledge on one side, and safe autonomy for an AI agent on
the other. Most attempts at "AI + your production systems" pick one and hope for the
best — either a smart assistant with dangerous access, or a safe integration that
can't do anything useful. Contrail's bet is that the safety model is what *unlocks*
the usefulness: because writes are provably human-gated and access is provably scoped,
you can comfortably let the assistant do far more of the real work.

It's also a concrete answer to a question the whole industry is asking right now —
*how do you actually let AI agents operate on critical business systems?* — grounded
in a domain where the stakes, the permissions, and the failure modes are all real.

---

## Status & direction

Phase 0 — the engine and its safety model — is complete and proven against a live org.
The path from here is toward broader use: a dedicated Salesforce connected app for
cleaner org authorization, a small round of internal pilots on real engagement work,
and expanding the assistant's metadata-building skill so it produces
deployment-ready, correctly-permissioned components by default.

---

*Contrail is an independent project by Ryley Hayes.*
