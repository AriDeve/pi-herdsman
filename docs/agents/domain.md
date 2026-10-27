# Domain docs

## Before exploring

Read the root `GLOSSARY.md` when it exists and the ADRs in `docs/adr/` that
touch the area being investigated. Proceed silently if a document is absent;
create domain documents when terms or decisions are resolved, not in advance.

## Layout

This repository uses a single context:

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/`: architecture decisions.

## Use the vocabulary

Use glossary terms when naming domain concepts in issues, proposals,
hypotheses, and tests. If a needed concept is missing, reconsider the term or
note the gap for domain modeling.

## Flag ADR conflicts

Surface proposed changes that conflict with an existing ADR. Do not contradict
an active ADR without superseding it in the same change.
