# templates

Page-level layout shells that compose design-system components into a screen shape —
list-plus-detail, dashboard grid, form wizard, settings panel.

**Why this is separate from `components/`:** a component is a reusable UI _element_ with
no knowledge of a page; a template is a _composition_ that decides where regions live
and how they respond to breakpoints. Keeping them apart stops a page layout from being
imported by an unrelated feature that only wanted one of its widgets.

Owned by `docs/16-UI-UX-AND-ACCESSIBILITY.md` (page structure, responsive behaviour) and
`docs/15-DESIGN-SYSTEM.md` (the tokens and components a template may use).

Templates are added as their screens are implemented. Nothing is placed here until the
page structure it implements is defined in `docs/16`.
