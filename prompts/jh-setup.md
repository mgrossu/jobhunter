---
description: Turn your CV into the approved base CV and set search preferences
argument-hint: "[path to CV, default: data/]"
---
Set up the job-hunter profile from the user's CV. Work through these steps in order and do not skip the user's approval.

1. Find the CV in ${1:-data/} (CV.docx, CV.pdf, .md or .txt) and extract its text. Use `pandoc -t plain` for .docx and `pdftotext -layout` for .pdf. If a tool is missing, tell the user how to install it.
2. Build the structured CV exactly as written. Do not improve, embellish, merge or invent anything.
   - Number roles e1, e2, ... newest first. Number each role's bullets e1.b1, e1.b2, ...
   - Copy bullet text verbatim. If the CV has paragraphs instead of bullets, split them into factual bullets without adding facts.
   - skills: every skill, tool, method and framework the CV names, using the CV's spelling.
   - engagement: "B2B contract", "Freelance" or "Employee" where the CV makes it clear.
3. Show the user a compact review: the roles with bullet counts, the skills list, certifications, languages, and anything you were unsure about. Ask them to correct it. Apply their corrections. They may add facts, but only facts they state.
4. Call `jh_save_base_cv`. The user confirms in a dialog.
5. Ask for search preferences, proposing these defaults: target roles (IT Project Manager, Program Manager, Delivery Manager, PMO), contract types (B2B, IČO / živnostenský list, freelance, contract), whether permanent employment is acceptable, home base Prague CZ, remote regions (EU/EEA, CET ±2h), onsite cities (Prague), minimum day rate in EUR, and dealbreakers. Then call `jh_save_preferences`.
6. Tell the user the next steps: `npm run fetch` for a dry run of the sources, then the nightly timer (see README).
