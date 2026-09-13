# Evabob — Design Documentation

**Source of truth:** the Figma file
`https://www.figma.com/design/dn7jOFLoZaEkrPFFAUCq3W/evabob` (Page 1).

**Handoff status:** design-complete and engineering-ready as of 13 September
2026. The live file contains five foundation boards, 42 source components, 73
human-payment states, 12 agent-payment states, 20 public-web states, 20 reusable
recovery components, three explicitly future/testnet-gated screens, and a
dedicated address-copied confirmation. The prototype has 212 verified
interactions across the state boards and top-level product journeys. Section
`08 · HANDOFF & CHANGE LOG` contains the implementation contract, build order,
safety rules, accessibility baseline, responsive rules, QA checklist and dated
change log. Customer-facing dollar and euro amounts have been normalized to
`$` and `€` throughout the live product, component, flow, recovery and public-web
boards. Every public-web `TESTNET` label is contained by its badge frame. The
`2026-09-12` archive is reference-only.

**Target:** `mobile/` — Flutter, iOS + Android.
**Last updated:** 2026-09-13.

This document exists so the build matches the design without a designer in the
loop for every decision. Where a number is given, it is the number in the
Figma file, not an approximation. Where something is deliberately undefined,
it says so rather than leaving you to guess.

---

## 0. Read this first — three conflicts with what is already in the repo

The design in Figma is newer than both the written brief and the code. Three
things in the repo will actively fight you if you don't know they are stale.

### 0.1 `evabob-redesign-brief.md` Section 2 is superseded

The brief specifies a mint/lime/forest palette (`#EAFBDD`, `#8ED14A`,
`#1F4D2B`) and SF Pro. **Neither applies.** The palette is now blue-on-pale-blue
and the typeface is Numans. Everything else in the brief still stands and is
still binding:

- the scope restriction in the brief's opening block (visual only — no changes
  to API calls, Circle UCW / App Kit integration, chain logic, state management,
  routing, or data models),
- the copy rules in Section 2 and the screen-by-screen copy pass in Section 6,
- the motion description in Section 2 (spring with overshoot, press-scale 0.96,
  balance counts up, staggered list entry, respect reduced-motion).

### 0.2 `lib/core/theme/evabob_colors.dart` is a different design

That file implements a "Dark Mint" palette — near-black forest ground
(`#0A1712`), mint accent (`#00E599`), sage-grey secondary. It was a previous
iteration. The Figma design is **light mode**, blue accent, and the user has
explicitly asked for light mode, not dark.

The repoint strategy used in that file is still the right one: the legacy token
names are kept and repointed rather than renamed, because several hundred call
sites reference them. Do the same again — repoint the existing names to the
values in §1.1 below rather than renaming across 30 screens. Section 9 gives the
mapping.

### 0.3 `lib/core/theme/evabob_tokens.dart` type scale does not match

The code has a seven-step Inter scale with weights from w600 to w800 and a
44px hero. The design has **four sizes and one weight**. Weight-based hierarchy
has to come out; see §1.2 for why and §9.3 for the replacement.

---

## 1. Foundations

### 1.1 Colour

Nine tokens. One accent. Everything else is neutral. Colour carries meaning
here — it is not decoration, and there is no second accent to reach for.

| Token | Hex | Figma 8-digit | Role |
|---|---|---|---|
| `blue` | `#00B5FF` | `#00B5FFFF` | The one accent. Primary buttons, active tab, active chip/segment, progress fill, links, selected states, initial-badge marks, unread dots. |
| `lightBlue` | `#F0FAFF` | `#F0FAFFFF` | Page background on every screen. Also the fill for badges and inactive chips **when they sit on white**. |
| `lightDark` | `#ACE3FF` | `#ACE3FFFF` | Tinted track behind a blue progress fill where the fill needs to read as "part of" the accent rather than sitting on grey. Used on the Agent detail hero bar. Sparing. |
| `ink` | `#0B1620` | `#0B1620FF` | Primary text. Names, amounts, titles, row labels. |
| `sec` | `#5A6B78` | `#5A6B78FF` | Secondary text. Row subtitles, helper copy, inactive tab labels, inactive chip labels, glyph icons that are not active. |
| `tert` | `#64727E` | `#64727EFF` | Tertiary text. **Section headers only**, plus timestamps in the notification list. |
| `sep` | `#E6EBEF` | `#E6EBEFFF` | Hairline separators, inactive toggle tracks, progress-bar tracks, the sheet grabber. |
| `white` | `#FFFFFF` | `#FFFFFFFF` | Card and sheet surfaces, labels on blue. |
| `moneyIn` | `#01FFA6` | `#01FFA6FF` | **Text colour only.** See §1.1.1. |

Derived values, used as literals in the file:

| Purpose | Value |
|---|---|
| Modal scrim | `#0B1620A6` (ink at 65%) |
| Home indicator | `#0B162047` (ink at 27.8%) |
| Card shadow | `#0B16200F` (ink at 6%) |
| Sheet / knob shadow | `#0B162029` (ink at 16%) |
| Sticky header shadow | `#0B162014` (ink at 8%) |
| Primary button shadow | `#00B5FF47` (blue at 28%) |

#### 1.1.1 The money-in green — read this before you touch it

`#01FFA6` is applied as **text colour** on incoming amounts (`+$120.00`,
`+$60.00`). It is never a background, never a chip fill, never a badge. This is
an explicit product decision and it has already been reversed once — an earlier
pass rendered it as a filled green chip with dark text to fix contrast, and that
was rejected. Do not "fix" it that way again.

The honest measurement, so you are not surprised in review: `#01FFA6` on
`#FFFFFF` is roughly **1.3:1**. It fails WCAG AA for body text by a wide margin.
It is in the design deliberately as a brand signal, and the information it
carries is redundant — the `+` sign and the row's subtitle ("Sent to you")
both encode direction without relying on colour. So no information is lost to a
user who cannot perceive it, which is what makes the choice defensible.

If you want to improve it without changing the decision, the levers are:
darkening only the on-white variant, or keeping the green and adding weight —
**not** swapping to a filled surface.

### 1.2 Typography

**Numans Regular, 400. One weight. There is no bold.**

The font file ships at `mobile/assets/Numans/Numans-Regular.ttf` (SIL OFL,
licence alongside it). It is a single-weight family — there is no 500, 600 or
700 to load.

This is the single most important thing to get right, because it inverts the
usual habit. Hierarchy comes from **size and colour only**. If a heading does
not feel prominent enough, the answer is a larger size or darker ink, never a
heavier weight.

Do not use Flutter's synthetic bolding to compensate. Setting
`fontWeight: FontWeight.w700` on a single-weight family makes Skia fake the
weight by smearing the outline; it looks muddy at 14px and it will not match
the Figma render. Every text style in the app should resolve to `w400`.

**The scale — four sizes, no others:**

| Name | Size | Line height | Tracking | Colour | Used for |
|---|---|---|---|---|---|
| Hero | 48 | 56 | −1 | `ink` | The one big number on a screen. Balance, amount being entered, receipt amount, agent remaining. |
| Title | 22 | 28 | −0.2 | `ink` | Root-screen titles, sheet titles, the name on a receipt, single-field input values. |
| Body | 14 | 18 | −0.1 | `ink` / `sec` / `white` | Everything else. Row names, amounts in rows, button labels, helper copy, chip labels. |
| Label | 10 | 14 | +0.2 | `sec` / `tert` | Row subtitles, avatar captions, timestamps, pill labels. |

Two variants of the 10px step:

| Variant | Size | Line height | Tracking | Case | Colour |
|---|---|---|---|---|---|
| Section header | 10 | 14 | **+0.8** | UPPERCASE | `tert` `#64727E` |
| Tab label | 10 | **12** | +0.2 | Sentence | `blue` active / `sec` inactive |

Tracking is in **pixels**, not percent or em — that is how it is stored in the
file and how the type scale was authored. In Flutter, `letterSpacing` is already
in logical pixels, so the numbers transfer directly.

The negative tracking on the larger sizes is not optional polish. At 48px,
default Numans tracking reads loose and amateurish; −1 is what makes the balance
figure look set rather than typed.

#### 1.2.1 Inter Black — the icon escape hatch

`Inter` at weight **900** is used for one purpose: glyphs where no SVG icon
exists. It is a typographic icon, not text.

Current uses, all of them:

| Glyph | Size | Where |
|---|---|---|
| `‹` | 22 / lh 28 | Back button chevron, every subscreen |
| `›` | 14 / lh 18 | Row disclosure chevrons |
| `×` | 14 / lh 18 | Clear-field button |
| `⌫` | 18 | Keypad delete key |
| Initials (`GR`, `TE`, `SP`…) | 14 or 16 or 22 | Initial badges where a person has no photo |

Never set body copy in Inter. Never set an initial badge in Numans. Inter is
already declared in `pubspec.yaml` as a variable font, so weight 900 maps to the
`wght` axis and needs no extra asset.

### 1.3 Grid, spacing and measure

Artboard: **390 × 844** (iPhone 14/15 logical size). Every frame in the file is
this size, laid out in one row at `y = 0`, spaced **510px** apart on the canvas
so there is a 120px gutter between artboards.

| Rule | Value |
|---|---|
| Page side margin | **20** |
| Content width | **350** (`390 − 20 − 20`) |
| Card inset from page edge | 20, so cards are 350 wide at `x = 20` |
| Card inner padding | **16**, so card content starts at `x = 36` |
| Text column when a row has a 40px badge | `x = 88` (`36 + 40 + 12`) |
| Right-aligned value column | `x = 240`, width 110, ends at 350 |
| Row pitch in a list | **72** |
| Separator inside a badge row | 262 × 1 at `x = 88` (aligns to text, not to the badge) |
| Separator inside a plain row | 306 × 1 at `x = 36` |

Everything lands on the 8pt grid; 4pt is used only for optical centring (a
10px label sitting 2px off a 14px name so the pair looks centred against a
40px badge).

**Vertical anchors that repeat on every screen:**

| Element | Position |
|---|---|
| Status bar time `9:41` | `(28, 17)`, Body 14/18, tracking 0 |
| Root screen title | `(20, 62)`, Title 22 |
| Back button | ellipse 44 × 44 white at `(20, 54)` |
| Back chevron `‹` | `(20, 62)`, Inter 900 22/28, centred, maxWidth 44 |
| Nav title (subscreens) | `(70, 65)`, Body 14/18 tracking **0**, centred, maxWidth 250 |
| First section header | `y = 120` |
| Primary button | 350 × 56 at `(20, 752)` |
| Primary button label | `(20, 771)`, Body 14, white, centred, maxWidth 350 |
| Home indicator | 130 × 5 at `(130, 834)`, radius 3, `#0B162047` |

The nav title sits at tracking 0, not −0.1, because it is centred against a
fixed 250px box and the tighter tracking made it read as drifting left against
the back button.

### 1.4 Corner radii

The radius scale was **halved** from an earlier iteration at the user's
instruction — "use half the radius you use for every card: 20 to 10, 24 to 12,
28 to 14." If you find a 20 or 24 anywhere, it is a leftover and it is wrong.

| Element | Radius | Corner smoothing |
|---|---|---|
| Card | 12 | 0.6 |
| Bottom sheet, tab bar | 16 | 0.6 |
| Keypad key, chat composer | 14 | 0.6 |
| Tile | 10 | 0.6 |
| Pill, button, chip, toggle, badge, avatar | 999 | 0 (a circle needs none) |
| Sheet grabber | 2 | 0 |
| Home indicator | 3 | 0 |

**Corner smoothing 0.6 is a squircle**, not a plain rounded rect. It applies to
anything with radius ≥ 8. Flutter's `BorderRadius.circular()` does **not** do
this — it produces a circular-arc corner, which reads subtly cheaper next to the
Figma render. Options, in order of preference:

1. `ContinuousRectangleBorder` / `SmoothRectangleBorder` from the
   `figma_squircle` package (matches Figma's algorithm closely, `cornerSmoothing:
   0.6`),
2. accept `BorderRadius.circular()` and note it as a known delta.

Do not ship a mix of the two — pick one and apply it everywhere, so cards don't
disagree with sheets.

### 1.5 Elevation

Five shadows. There are no borders anywhere in this design — depth does the job
a 1px stroke would otherwise do.

| Name | Colour | Offset Y | Blur | Spread | Applied to |
|---|---|---|---|---|---|
| Card | `#0B16200F` | +8 | 24 | −6 | Every white card, input field, hero badge |
| Sheet | `#0B162029` | **−8** | 40 | 0 | Bottom sheets — shadow goes *up*, because the sheet is rising from the bottom edge |
| Button | `#00B5FF47` | +10 | 24 | −6 | Primary blue buttons — a coloured shadow, so the button glows rather than casts |
| Knob | `#0B162029` | +2 | 4 | 0 | Toggle knobs |
| Header | `#0B162014` | +6 | 16 | 0 | The sticky header on Home · scrolled |

The negative spread on the card and button shadows is what keeps them from
looking like a drop-shadow filter — the shadow is smaller than the shape, so it
reads as the object sitting close to the surface rather than floating above it.

### 1.6 Motion

Motion is not specified per-screen in the Figma file (it is a static design).
The brief's Section 2 governs, and `lib/core/theme/evabob_tokens.dart` already
implements it correctly — `Motion.spring` = `Cubic(0.34, 1.4, 0.36, 1.0)`,
`pressScale` 0.96, `stagger` 45ms, and a `Motion.reduced()` check wired to
`MediaQuery.disableAnimations`.

**Keep that class as-is.** It is the one part of the existing theme layer the
new design does not change. Specifically:

- sheets spring up with slight overshoot, not a linear slide,
- buttons and chips scale to 0.96 on press,
- the balance figure counts up on load rather than snapping in,
- list rows stagger in with fade + rise, 45ms apart,
- when `Motion.reduced(context)` is true, all of the above become plain opacity
  crossfades. This matters — a springing, overshooting interface is genuinely
  unpleasant for someone with vestibular sensitivity.

---

## 2. Components

Exact specs. These repeat across many screens; build them once.

### 2.1 Card

White, 350 wide, `x = 20`, radius 12 / smoothing 0.6, card shadow. Height is
always `16 + (72 × rowCount) + 16` when it holds rows — i.e. 104 for one row,
216 for three, 288 for four.

Content starts at `x = 36` (16 inset). Separators sit **between** rows, never
above the first or below the last, and they inset to the text column so the
badge column reads as a continuous rail.

### 2.2 List row

The workhorse. Pitch 72. Given a row starting at `y`:

| Part | Geometry |
|---|---|
| Badge / avatar | 40 × 40 at `(36, y + 16)`, radius 999 |
| Initial mark | Inter 900 14, `blue`, centred, maxWidth 40, at `(36, y + 27)` |
| Name (single line) | Body 14 `ink` at `(88, y + 27)` |
| Name (with subtitle) | Body 14 `ink` at `(88, y + 18)` |
| Subtitle | Label 10 `sec` at `(88, y + 38)` |
| Value | Body 14 at `(240, y + 26)`, maxWidth 110, **right-aligned** |
| Separator | 262 × 1 `sep` at `(88, y + 72)` |

The two name positions exist because a name+subtitle pair has to optically
centre against the 40px badge as a block, while a lone name centres on its own.
Getting this wrong by 9px is the most common way these rows end up looking
slightly off.

Value colour: `ink` normally, `moneyIn` for incoming amounts, `sec` for
cancelled or inactive rows.

### 2.3 Chip / segmented control

Height **40**, radius 999. Label is Body 14, centred, with `maxWidth` set to the
chip's own width and `y = chipY + 11`.

| State | Fill on a `lightBlue` page | Fill on a white card | Label |
|---|---|---|---|
| Active | `blue` | `blue` | `white` |
| Inactive | `white` | `lightBlue` | `sec` |

Inactive chips flip fill depending on what they sit on — the chip must always
be a step away from its ground, never the same colour.

Widths are computed to fill the 350 content width with 8px gaps, then rounded
to whole pixels. Worked examples from the file:

- 3 equal chips → 111 / 112 / 111 at `x = 20 / 139 / 259`
- 4 equal chips → 81 / 82 / 81 / 82 at `x = 20 / 109 / 199 / 288`
- 2 equal chips (segmented control) → 171 / 171 at `x = 20 / 199`
- content-width chips → size to the label + 40px padding, left-aligned, 8px gaps

### 2.4 Primary button

350 × 56 at `(20, 752)`, radius 999, fill `blue`, button shadow. Label Body 14
white, centred, maxWidth 350, at `y = 771`.

There is exactly one per screen. If a screen needs a second action it is a text
link or a card row, not a second filled button.

### 2.5 Bottom sheet

| Part | Geometry |
|---|---|
| Scrim | 390 × 844 at `(0, 0)`, `#0B1620A6` |
| Sheet | 390 wide, `x = 0`, top at the sheet's `y`, radius 16 / smoothing 0.6, white, sheet shadow |
| Grabber | 40 × 4 at `(175, sheetY + 16)`, `sep`, radius 2 |

Sheet heights in the file: Activity · Receipt starts at `y = 200` (644 tall),
Activity · Filter starts at `y = 260` (584 tall). The rule is that the sheet is
as tall as its content needs and no taller — it is not a fixed detent.

The home indicator on a sheet screen sits on top of the sheet, same position as
everywhere else.

### 2.6 Toggle

| Part | Geometry |
|---|---|
| Track | 51 × 31, radius 999 |
| Knob | 27 × 27, radius 999, `white`, knob shadow |
| Knob Y | `trackY + 2` |
| ON | track `blue`, knob `x = trackX + 22` |
| OFF | track `sep`, knob `x = trackX + 2` |

Right-aligned in a row: track at `x = 299` (ends at 350).

### 2.7 Progress bar

Radius 999 on both track and fill; fill is `blue` and starts at the same origin
as the track.

| Context | Height | Track colour | Width |
|---|---|---|---|
| In a list row | 6 | `sep` | 258, at `x = 96` |
| Hero on a detail screen | 8 | `lightDark` | 350, at `x = 20` |

Fill width is `trackWidth × fraction`, rounded to a whole pixel. The design
shows **spent**, not remaining — a nearly-full bar means the budget is nearly
gone.

### 2.8 Avatar and initial badge

Photos come from `assets/dp-png/{1..22}.png` (400 × 400 RGB). Always radius 999.

| Size | Where |
|---|---|
| 64 | Receipt header, detail-screen hero |
| 48 | Avatar pickers (Filter sheet) |
| 44 | Agent cards |
| 40 | Standard list rows |
| 32 | Compact sticky header |

When there is no photo, use an initial badge: a circle filled `lightBlue` with
two initials in Inter 900, `blue`, centred.

| Badge size | Mark size | Mark Y offset |
|---|---|---|
| 40 | 14 | `+11` |
| 44 | 16 | `+12` |
| 64 | 22 | `+18` |

A paused or inactive entity uses a `sep` badge with a `sec` mark. A first-party
system notice uses a `blue` badge with a `white` mark.

**People get photos. Shops and services get initial badges.** That split is
deliberate — it makes a human transaction visually distinct from a merchant one
at a glance, without a label.

### 2.9 Floating tab bar

A group 358 × 87 at `(16, 752)`.

| Part | Geometry |
|---|---|
| Bar | rounded, radius 16 / smoothing 0.6, white |
| Icons | 22 × 22 at `y = 772` — home `x 41`, chat `x 111`, activity `x 257`, wallet `x 327` |
| Labels | Tab 10/12/+0.2, centred, at `y = 798` — Home, Chat, Activity (`x 234`, w 68), Wallet (`x 302`, w 72) |
| FAB | ellipse + glyph, centred around `x ≈ 195` |
| Home indicator | `y = 834` |

The FAB sits in the gap between Chat and Activity — the four tabs are two
either side of it, which is why the icon x-positions are not evenly spaced.

Active tab: icon uses the `-blue` asset, label is `blue`. Inactive: `-sec`
asset, label `sec`.

### 2.10 Numeric keypad

Used by Convert, Request, Send · PIN, Sign in, Sign in · Code, Set a PIN.

Digits are Numans 22, `ink`, centred, `maxWidth 110`, in three columns at
`x = 20 / 140 / 260`. The delete key is `⌫` in Inter 900 18, `sec`, nudged
**+2px in Y** relative to the digit baseline so it optically centres — the
glyph's own bearing sits high.

---

## 3. Screen inventory

The original product-screen strip is laid out at `y = 0`, 510px apart
(`x = 0, 510, 1020 …`) and is preserved for implementation reference. The live
file now also has structured sections `01`–`08` for foundations, components,
human flows, agent flows, public-web flows, recovery, future scope and handoff.
Node IDs below identify the original product frames; use the structured sections
for current state coverage and the handoff contract.

### 3.1 Core app

| Screen | Node ID | x |
|---|---|---|
| Home | `2:2` | 0 |
| Chat · List | `2:148` | 1530 |
| Chat · Thread | `3:194` | 2040 |
| Home · More menu | `5:233` | 2550 |
| Activity | `5:255` | 3060 |
| Activity · Receipt | `18:969` | 10200 |
| Activity · Filter | `18:970` | 10710 |
| Home · scrolled | `21:1223` | 16830 |
| Notifications | `21:1284` | 17340 |
| Chat · Evabob | `43:1784` | 18870 |
| Chat · New chat | `43:1814` | 19380 |
| Activity · Didn't land receipt | `52:2468` | 36210 |
| Home · All activity | `55:2804` | 42330 |
| Chat · Thread menu | `56:2918` | 43350 |
| Activity · Nothing yet | `56:2970` | 43860 |
| Loading | `56:2991` | 44370 |
| No connection | `56:3014` | 44880 |
| Long name and amount | `57:3027` | 45390 |

### 3.2 Send / Request

| Screen | Node ID | x |
|---|---|---|
| Send · Amount | `2:71` | 510 |
| Send · Sent | `2:121` | 1020 |
| Send · On the way | `17:609` | 6120 |
| Request · Ask for money | `17:635` | 6630 |
| Request · Sent | `17:674` | 7140 |
| Send · Who's this for? | `17:699` | 7650 |
| Send · Confirm sheet | `18:736` | 8160 |
| Send · PIN | `18:759` | 8670 |
| Send · Held for them | `18:788` | 9180 |
| Request · history | `21:1333` | 17850 |
| Send · Add a note | `32:1692` | 23460 |
| Send · Paste an address | `40:1716` | 23970 |
| Send · Search results | `41:1745` | 24480 |
| Send · No match | `41:1733` | 24990 |
| Send · Invite someone | `41:1766` | 25500 |
| Send · Switch currency | `43:2006` | 26010 |
| Send · Not enough money | `32:1703` | 26520 |
| Request · Asked of you | `52:2334` | 33150 |
| Request · Detail | `52:2358` | 33660 |
| Request · Pay | `52:2381` | 34170 |
| Claim held money | `52:2403` | 34680 |
| evabob.me link page | `52:2426` | 35190 |
| Send · Didn't land | `52:2449` | 35700 |
| Send · Amount menu | `56:2859` | 42840 |

### 3.3 Wallet / money movement

| Screen | Node ID | x |
|---|---|---|
| Wallet · Balances | `16:383` | 3570 |
| Wallet · Receive | `17:443` | 4080 |
| Wallet · Gateway Account | `17:479` | 4590 |
| Convert | `17:536` | 5100 |
| Move money | `17:572` | 5610 |
| Scan | `18:817` | 9690 |
| Networks | `32:1640` | 18360 |
| Scan · Found it | `43:2073` | 27030 |
| Scan · Bad code | `43:2088` | 27540 |
| Scan · Camera off | `45:2100` | 28050 |
| Top up · Bank transfer | `45:2113` | 28560 |
| Top up · Debit card | `45:2138` | 29070 |
| Top up · Another wallet | `46:2162` | 29580 |
| Cash out | `46:2178` | 30090 |
| Convert · Done | `46:2204` | 30600 |
| Move money · Choose network | `46:2226` | 31110 |
| Move money · Amount | `52:2257` | 31620 |
| Move money · On the way | `52:2291` | 32130 |
| Move money · Done | `52:2312` | 32640 |

### 3.4 Onboarding / security

| Screen | Node ID | x |
|---|---|---|
| Splash | `18:830` | 11220 |
| Sign in | `18:831` | 11730 |
| Sign in · Code | `18:832` | 12240 |
| Set a PIN | `18:833` | 12750 |
| Setting up your wallet | `18:834` | 13260 |
| Edit handle | `18:1045` | 14280 |
| App lock | `21:1082` | 14790 |
| Confirm your PIN | `43:1840` | 19890 |
| Choose your name | `43:1991` | 20400 |
| Face ID or fingerprint | `43:1865` | 20910 |
| Notifications permission | `43:1879` | 21420 |
| Wrong PIN | `43:1923` | 21930 |
| Locked out | `43:1953` | 22440 |
| Forgot your PIN | `43:1969` | 22950 |

### 3.5 Agent wallets

| Screen | Node ID | x |
|---|---|---|
| Agent wallets | `21:1114` | 15300 |
| Create an agent | `21:1156` | 15810 |
| Agent detail | `21:1188` | 16320 |
| Agent · Add money | `53:2495` | 36720 |
| Agent · Take money out | `54:2523` | 37230 |
| Agent · API key | `54:2551` | 37740 |
| Agent · Stop this agent | `54:2579` | 38250 |

### 3.6 Profile

| Screen | Node ID | x |
|---|---|---|
| Profile | `18:927` | 13770 |
| Profile · Get help | `54:2619` | 38760 |
| Profile · Terms | `54:2653` | 39270 |
| Profile · Sign out | `55:2675` | 39780 |
| Profile · Edit profile | `55:2727` | 40290 |
| Profile · Change PIN | `55:2748` | 40800 |
| Profile · Your currency | `55:2774` | 41310 |
| Profile · Delete account | `32:1669` | 41820 |

### 3.7 Reusable source nodes — do not delete

| Node | What |
|---|---|
| `2:73` | Back button ellipse, 44 × 44 white |
| `2:75` | Back chevron `‹`, Inter 900 22/28 |
| `2:120` | Home indicator, 130 × 5, radius 3 |
| `16:368` | The floating footer group (Activity tab active) |
| `2:77` | Nav title reference — 14/18/0, centred, w 250 |

Every subscreen's back button and home indicator is a clone of these. If you
change the source, re-clone rather than editing 30 copies.

---

## 4. Screen specifications

Full measurements are given for the screens where they were authored directly.
For the earlier screens, content and behaviour are specified here and exact
coordinates should be read off the frame in Dev Mode — they follow the rules in
§1 and §2 without exception.

### 4.1 Home (`2:2`)

Root screen, no back button. Page fill `lightBlue`.

Structure top to bottom: hero gradient panel with a soft bloom ellipse; status
time; profile name and handle with the user's photo (`pfp / victor`); a "more"
ellipse button opening the overflow menu; the balance as three separate text
nodes — **whole**, **decimals**, and **local** — so the decimals can be set
smaller and the whole number can count up independently.

Below that: the action row — a **Send** pill, a circular **Scan** button holding
a QR frame, and a **Request** pill. Then `label / spendable`, a pager
(`pager / active` + `pager / rest`) for the swipeable per-chain card stack, the
secondary asset amount and label, and `footnote / chain` naming the chain
quietly at the bottom of the card.

Then a white sheet (`Sheet`) carrying: "Your money" with a "View all" link; two
cards — **on hold** and **for apps** — each with a badge ellipse, a ring, a
label, a whole amount and a separate decimals node; then "Money in" with a range
label, an income card, a delta chip, and a seven-bar chart (`bar 1`…`bar 7`).

Finally the tab bar with `tab / active pill` and four icon frames, and the home
indicator.

**Note on the balance:** the split into whole/decimals/local nodes is what makes
the count-up animation possible without the decimals jittering. Keep the split
in code.

### 4.2 Home · scrolled (`21:1223`)

The scrolled state of Home. The hero collapses into a sticky header.

| Element | Geometry |
|---|---|
| Sticky header | 390 × 104 at `(0, 0)`, white, header shadow |
| User photo | 32 × 32 at `(20, 56)`, radius 999 |
| Balance | Title 22 `ink` at `(62, 56)` — `$1,120.00` |
| "Spendable" | Label 10 `sec` at `(62, 80)` |
| Section "TODAY" | `(20, 124)` |
| Today card | 350 × 216 at `(20, 148)` — 3 rows |
| Section "YESTERDAY" | `(20, 396)` |
| Yesterday card | 350 × 288 at `(20, 420)` — 4 rows |
| Tab bar | Home active |

Rows, in order: Hannah (photo, "Sent to you", `+$120.00` in `moneyIn`); Tesco
(`TE` badge, "Card · 9:12", `$24.10`); Marcus (photo, "You sent", `$45.00`) —
then Priya (photo, "Sent to you", `+$60.00` green); Spotify (`SP`, "Monthly",
`$11.99`); Dad (photo, "You sent", `$200.00`); Corner shop (`CO`,
"Card · 18:40", `$8.20`).

The header shadow only appears once the list has scrolled under it — at scroll
offset 0 the header is flat against the page.

### 4.3 Activity · Receipt (`18:969`)

Bottom sheet, scrim `#0B1620A6`, sheet from `y = 200`.

| Element | Geometry |
|---|---|
| Grabber | `(175, 216)` |
| Photo | 64 × 64 at `(163, 244)` |
| Name | Title 22 centred, maxWidth 350, at `(20, 322)` — "Hannah" |
| Amount | Hero 48 centred, maxWidth 350, at `(20, 352)` — "$120.00" |
| Status pill | 80 × 28 at `(155, 414)`, `lightBlue`, radius 999 |
| Pill label | Label 10 `blue` centred, maxWidth 80, at `(155, 421)` — "Landed" |
| Detail card | 350 × 256 at `(20, 470)`, fill **`lightBlue`**, radius 12 |
| Separators | 318 × 1 at `x = 36`, `y = 534 / 598 / 662`, colour `#DCEEF9` |
| Button | `(20, 750)` — "Bob Hannah again" |

Four label/value pairs inside the card, labels at `x = 36` (Label 10, `sec`),
values right-aligned at `x = 174` width 180 (Body 14, `ink`):

| Label | Value | Y (label / value) |
|---|---|---|
| When | Today at 9:12 | 496 / 492 |
| Came from | Your spending balance | 560 / 556 |
| Landed on | Base · 18 seconds | 624 / 620 |
| Note | Rent, second half | 688 / 684 |

This card is `lightBlue` on white rather than white on `lightBlue` — it is a
recessed well inside the sheet, not a raised card, so it takes the tint and a
lighter separator (`#DCEEF9`) instead of `sep`.

### 4.4 Activity · Filter (`18:970`)

Bottom sheet from `y = 260`, 584 tall.

| Element | Geometry |
|---|---|
| Grabber | `(175, 276)` |
| Title "Filter" | Title 22 at `(20, 300)` |
| "Reset" | Body 14 `blue`, right-aligned, maxWidth 100, at `(270, 305)` |
| SHOW | `(20, 352)` — chips at `y = 376`: Everything (active) / Money in / Money out |
| WHEN | `(20, 444)` — chips at `y = 468`: Any time (active) / Today / 7 days / 30 days |
| PEOPLE | `(20, 536)` — avatar strip at `y = 560` |
| HOW IT ENDED | `(20, 656)` — chips at `y = 680`: Landed / On the way / Didn't land |
| Button | `(20, 752)` — "Show 24 results" |

Avatar strip: 48px circles at `x = 20 / 92 / 164 / 236 / 308` (pitch 72), with
captions at `y = 616`, Label 10 centred, maxWidth 48. The first is an "All"
badge — `lightBlue` fill, `blue` Inter 900 mark, **2px `blue` stroke** marking
selection, caption in `blue`. The rest are photos with `sec` captions.

Selection on an avatar is a ring, not a checkmark — there is no room for one at
48px and the ring reads faster.

The button label carries a live count ("Show 24 results"). It updates as
filters change; when the result set is empty it should read "No results" and
the button goes to a disabled state (not yet designed — see §11).

### 4.5 Edit handle (`18:1045`)

| Element | Geometry |
|---|---|
| Nav title | "Your handle" |
| YOUR HANDLE | `(20, 120)` |
| Field | 350 × 64 at `(20, 144)`, white, radius 12, card shadow |
| `@` prefix | Title 22 `sec` at `(36, 162)` |
| Value | Title 22 `ink` at `(58, 162)` — "victor" |
| Clear button | 28 × 28 at `(322, 162)`, `lightBlue`, radius 999 |
| Clear glyph `×` | Inter 900 14 `sec`, centred, maxWidth 28, at `(322, 169)` |
| Availability icon | `checkmark-blue` 16 × 16 at `(20, 225)` |
| Availability text | Body 14 `blue` at `(44, 224)` — "This one's free" |
| RULES | `(20, 268)` |
| Rules card | 350 × 136 at `(20, 292)` |
| SUGGESTIONS | `(20, 452)` |
| Suggestion chips | `y = 476` — `@victor.e` (105) / `@victore` (98) / `@vic` (69) at `x = 20 / 133 / 239`, white fill |
| Button | "Save handle" |

Rules card rows: a 6px `blue` dot at `x = 36` and Body 14 `ink` at `x = 56`,
rows at `y = 308 / 348 / 388`, separators 306 × 1 at `(36, 336)` and `(36, 376)`.
Copy: "3 to 20 characters" / "Letters, numbers and underscores" / "You can
change it once a month".

The `@` is a separate node from the value so the prefix can stay `sec` while
the typed value is `ink` — and so the caret lands after the prefix, not before
it.

### 4.6 App lock (`21:1082`)

| Element | Geometry |
|---|---|
| Nav title | "App lock" |
| UNLOCK WITH | `(20, 120)` |
| Card | 350 × 144 at `(20, 144)` — 2 rows |
| Row 1 | "Face ID" at `(36, 171)`, toggle **ON** at `(299, 164)` |
| Separator | `(36, 216)` |
| Row 2 | "PIN code" at `(36, 243)`, toggle **OFF** at `(299, 236)` |
| LOCK AFTER | `(20, 312)` |
| Card | 350 × 216 at `(20, 336)` — 3 rows |
| Rows | "Right away" `(36, 363)` + `checkmark-blue` 18 × 18 at `(324, 363)`; "After 1 minute" `(36, 435)`; "After 5 minutes" `(36, 507)` |
| Separators | `(36, 408)`, `(36, 480)` |
| ALSO | `(20, 576)` |
| Card | 350 × 144 at `(20, 600)` — 2 rows |
| Row 1 | "Hide amounts when locked" `(36, 627)`, toggle ON `(299, 620)` |
| Row 2 | "Ask before sending over $100" `(36, 699)`, toggle OFF `(299, 692)` |

No save button — settings apply immediately. That is why there is no primary
button on this screen and the content simply ends above the home indicator.

### 4.7 Agent wallets (`21:1114`)

| Element | Geometry |
|---|---|
| Nav title | "Agent wallets" |
| YOUR AGENTS | `(20, 120)` |
| Agent cards | 350 × 104 at `y = 144 / 260 / 376` (pitch 116) |
| Note card | 350 × 88 at `(20, 492)` |
| PAUSED | `(20, 612)` |
| Paused card | 350 × 88 at `(20, 636)` |
| Button | "Create an agent" |

Each agent card, given card `y`:

| Part | Geometry |
|---|---|
| Badge | 44 × 44 at `(36, y + 16)`, `lightBlue` |
| Mark | Inter 900 16 `blue`, centred, maxWidth 44, at `(36, y + 28)` |
| Name | Body 14 `ink` at `(96, y + 20)` |
| Sub | Label 10 `sec` at `(96, y + 42)` |
| Remaining | Body 14 `ink` right-aligned, maxWidth 100, at `(254, y + 20)` |
| Bar track | 258 × 6 `sep` at `(96, y + 70)` |
| Bar fill | `blue`, same origin |

Content: Groceries `GR` — "$60 spent of $100 this week" — "$40 left" — fill 155
(60%); Transit `TR` — "$22 spent of $30 this week" — "$8 left" — fill 189 (73%);
Coffee `CO` — "$5 spent of $40 this week" — "$35 left" — fill 32 (12.5%).

Note card copy, Body 14 `sec` at `(36, 516)` wrapped to maxWidth 302, two lines:
"Agents spend from your spending balance. You can stop one any time."

Paused card: badge `sep` with `sec` mark `BK`, name "Books" at `(96, 662)`,
sub "Paused on 2 Sep" at `(96, 684)`, and **"Resume"** in Body 14 `blue`,
right-aligned maxWidth 100, at `(254, 671)`.

### 4.8 Create an agent (`21:1156`)

| Element | Geometry |
|---|---|
| WHAT IT'S FOR | `(20, 120)` |
| Name field | 350 × 64 at `(20, 144)`, value Title 22 `ink` at `(36, 162)` |
| SPENDING LIMIT | `(20, 240)` |
| Amount | Hero 48 centred, maxWidth 350, at `(20, 272)` — "$100" |
| Preset chips | `y = 352` — $50 (76) / $100 (84, **active**) / $200 (84) / Custom (82) at `x = 20 / 104 / 196 / 288`, inactive fill white |
| RESETS | `(20, 424)` |
| Card | 350 × 144 at `(20, 448)` — "Every week" `(36, 475)` + check at `(324, 475)`; "Every month" `(36, 547)`; separator `(36, 520)` |
| WHERE IT CAN SPEND | `(20, 616)` |
| Card | 350 × 88 at `(20, 640)` — "Anywhere" `(36, 662)`, "Any shop or person" `(36, 684)`, chevron `›` at `(322, 670)` |
| Button | "Create agent" |

The hero amount and the preset chips are bound to each other — tapping a chip
sets the hero, and "Custom" opens the keypad (§2.10).

### 4.9 Agent detail (`21:1188`)

| Element | Geometry |
|---|---|
| Nav title | "Groceries" |
| Hero badge | 64 × 64 at `(163, 110)`, **white** + card shadow |
| Hero mark | Inter 900 22 `blue`, centred, maxWidth 64, at `(163, 128)` |
| Amount | Hero 48 centred at `(20, 194)` — "$40" |
| Sub | Body 14 `sec` centred at `(20, 258)` — "left of $100 this week" |
| Bar track | 350 × 8 at `(20, 296)`, **`lightDark`** |
| Bar fill | 210 × 8 `blue` (60%) |
| RECENT | `(20, 344)` |
| Card | 350 × 216 at `(20, 368)` — 3 rows, standard row geometry |
| MANAGE | `(20, 608)` |
| Card | 350 × 144 at `(20, 632)` — "Change the limit" `(36, 659)`; "Stop this agent" `(36, 731)`; separator `(36, 704)`; chevrons `›` at `(318, 658)` and `(318, 730)` |

Recent rows: Tesco `TE` `$24.10`; Corner shop `CO` `$18.40`; Market stall `MA`
`$17.50`.

The hero badge is **white** here, not `lightBlue` — it sits on the `lightBlue`
page, so it needs to be the lighter element to lift off it. This is the inverse
of the badge-in-a-card case and it is correct.

### 4.10 Notifications (`21:1284`)

| Element | Geometry |
|---|---|
| NEW | `(20, 120)` |
| Card | 350 × 216 at `(20, 144)` — 3 rows |
| EARLIER | `(20, 392)` |
| Card | 350 × 288 at `(20, 416)` — 4 rows |

Row geometry differs from the standard row because of the unread column:

| Part | Geometry |
|---|---|
| Unread dot | 6 × 6 `blue` at `(28, y + 33)` — **NEW section only** |
| Badge / photo | 40 × 40 at `(44, y + 16)` |
| Title | Body 14 `ink` at `(96, y + 18)` |
| Subtitle | Label 10 `sec` at `(96, y + 38)` |
| Timestamp | Label 10 **`tert`** right-aligned, maxWidth 100, at `(250, y + 20)` |
| Separator | 258 × 1 at `(96, y + 72)` |

Content — NEW: Hannah sent you money / $120.00 landed / 9:12 · Groceries agent
spent / $24.10 at Tesco / 9:08 (`GR` badge) · Marcus asked for $45 / Rent,
second half / 8:40. EARLIER: Priya sent you money / $60.00 landed / Yesterday ·
Spotify took $11.99 / Monthly / Yesterday (`SP`) · You sent Dad $200.00 /
Landed in 12 seconds / Yesterday · Your handle is live / People can find you at
@victor / 2 Sep (`EB` badge, **`blue` fill, white mark** — first-party notice).

Titles must stay under ~150px at 14px or they collide with the timestamp
column. Keep them short; put the detail in the subtitle.

### 4.11 Request · history (`21:1333`)

| Element | Geometry |
|---|---|
| Nav title | "Requests" |
| Segmented control | 2 × 171 at `(20, 116)` and `(199, 116)` — "You asked" (active) / "Asked of you" |
| WAITING | `(20, 180)` |
| Card | 350 × 216 at `(20, 204)` — 3 rows |
| DONE | `(20, 452)` |
| Card | 350 × 216 at `(20, 476)` — 3 rows |
| Button | "Ask for money" |

Standard row geometry. WAITING: Marcus / "Asked 2 days ago" / $45.00 · Priya /
"Asked yesterday" / $22.50 · Dad / "Asked today" / $150.00. DONE: Hannah /
"Paid today" / $120.00 · Marcus / "Paid on 2 Sep" / $30.00 · Priya / "You
cancelled" / $18.00 — this last amount is `sec`, not `ink`, because the request
no longer stands.

### 4.12 Send · Confirm sheet (`18:736`)

Sheet over scrim. Carries: sheet title, recipient photo, name and handle, a
detail card with three label/value pairs and two separators, a primary send
button, and a **cancel text link** below it — the one screen with a secondary
action, and it is a link rather than a second button.

### 4.13 The remaining screens

Convert, Move money, Send · Amount, Send · PIN, Sign in, Sign in · Code and
Set a PIN all use the keypad (§2.10). Wallet · Gateway Account uses the money-in
green on `+$500.00` / `+$120.00` as text.

Read exact coordinates from the frames; they follow §1 and §2.

---

## 5. Content and voice

The brief's no-jargon rule is binding. Two corrections were made during design
and both are permanent:

**"Gateway Account" is the product's name for that feature. Spell it out; do
not translate it.** An earlier pass renamed the menu item to "Top up" on the
grounds that "GA" was jargon. That was wrong. The plain-language rule is about
making unfamiliar words *readable*, not about deleting the product's own
vocabulary — expanding the acronym satisfies it, replacing the concept does not.

**"Move money" keeps the subtitle "Between networks you hold money on."** It
had been softened to "Shift money between your accounts"; that was reverted.

Beyond those:

- No tickers as labels. No "chain", "gas", "bridge", "CCTP", "UCW", "escrow",
  "unified balance".
- Customer-facing dollar amounts use `$` and euro amounts use `€`. Currency
  choices without an amount are named **Dollars** and **Euros**. Asset codes
  remain internal to APIs, settlement logic and data models and must never be
  interpolated directly into screen, chat, notification, receipt, error,
  agent-activity or public-link copy.
- Rates use the same presentation contract (`$1 ≈ €0.925`, never ISO or asset
  codes). Amounts place the symbol before the number with no intervening space.
- Pending sends say "Waiting for [name] to join" — never "escrow".
- Status language is plain and consistent: **On the way** → **Landed** →
  **Didn't land**. The Filter sheet uses exactly these three, so the rest of the
  app must too.
- Amounts always carry two decimals (`$45.00`, not `$45`), except the hero
  figure on Create an agent where the user is setting a round limit.
- Relative dates in lists: "Today", "Yesterday", then "2 Sep". Times as `9:12`.
- One hero element per screen. One supporting line maximum under any heading.

---

## 6. Assets

### 6.1 What exists

| Path | Contents | Format |
|---|---|---|
| `assets/Numans/Numans-Regular.ttf` | The typeface, single weight | TTF + `OFL.txt` |
| `assets/Inter/Inter.ttf` | Variable, used at 900 for glyph icons | TTF |
| `assets/dp-png/{1..22}.png` | Avatar photos, 400 × 400 RGB | PNG |
| `assets/dp-pic-asset/{1..22}.webp` | Same images, WebP | WebP |
| `assets/icons/*.svg` | `activity`, `chat`, `checkmark`, `home`, `qr`, `wallet` + `logo.webp` | SVG |
| `assets/icons-png/{name}-{tint}.png` | The same six icons pre-tinted, 144 × 144 RGBA | PNG |

Icon tints available: `-blue` `#00B5FF`, `-ink` `#0B1620`, `-sec` `#5A6B78`,
`-mid`, `-white`.

The PNG sets exist because the Figma plugin used to build the file could not
place SVGs. **In the app, use the SVGs** — `flutter_svg` is already a
dependency. Tint them at runtime with `ColorFilter` rather than shipping five
colour variants; that keeps one source of truth per icon and drops 24 files from
the bundle.

Avatar photos: prefer the WebP set in the app for size. The PNGs are the
Figma-facing copies.

### 6.2 `pubspec.yaml` needs three additions

Currently only `assets/challenge.html` and `assets/dp-pic-asset/` are declared,
and only the Inter family is registered. To build this design you need:

```yaml
flutter:
  uses-material-design: true
  assets:
    - assets/challenge.html
    - assets/dp-pic-asset/
    - assets/icons/          # add — the SVG icon set
  fonts:
    - family: Inter
      fonts:
        - asset: assets/Inter/Inter.ttf
        - asset: assets/Inter/Inter-Italic.ttf
          style: italic
    - family: Numans        # add — the app typeface
      fonts:
        - asset: assets/Numans/Numans-Regular.ttf
          weight: 400
```

Declare Numans at weight 400 explicitly. If you leave the weight off, Flutter
still resolves it, but any call site that asks for `w600` will silently
synthesise a fake bold instead of failing loudly — and you will not notice until
review.

---

## 7. Flutter implementation notes

### 7.1 Existing files this design maps onto

The feature layer already has a file per screen. This is a restyle, not a
re-architecture — the brief's scope restriction means the widget tree and the
services behind it stay.

| Figma frame | Existing file |
|---|---|
| Home, Home · scrolled | `lib/features/home/home_screen.dart` + `balance_cards.dart`, `action_row.dart`, `income_card.dart`, `chat_grid.dart` |
| Home · More menu | `lib/features/home/home_menu.dart` |
| Activity | `lib/features/activity/activity_screen.dart` |
| Activity · Receipt | `lib/features/activity/receipt_sheet.dart` |
| Activity · Filter | *(new — no file yet)* |
| Chat · List / Thread | `lib/features/chat/chat_list_screen.dart`, `chat_thread_screen.dart` |
| Send flow | `lib/features/send/send_screen.dart`, `amount_keypad.dart` |
| Send · Confirm sheet | `lib/core/widgets/confirm_payment_sheet.dart` |
| Request · Ask / Sent | `lib/features/request/request_screen.dart` |
| Request · history | `lib/features/request/invoice_history.dart` |
| Wallet · Balances | `lib/features/assets/assets_screen.dart` |
| Wallet · Gateway Account | `lib/features/gateway/gateway_screen.dart` |
| Convert | `lib/features/exchange/exchange_screen.dart` |
| Move money | `lib/features/bridge/bridge_screen.dart` |
| Scan | `lib/core/widgets/address_scan_sheet.dart` |
| Sign in / Code | `lib/features/auth/login_screen.dart` |
| App lock | `lib/features/auth/app_lock_screen.dart` + `lib/core/security/app_lock_service.dart` |
| Profile, Edit handle | `lib/features/profile/profile_screen.dart` |
| Agent wallets / Create / Detail | `lib/features/agents/agents_screen.dart` |
| Tab bar | `lib/features/shell/app_shell.dart` |

`lib/core/widgets/bundle_avatar.dart` is the natural home for §2.8 (photo vs
initial badge). `lib/core/widgets/glass.dart` is for the old translucent panels
and has no role in this design.

### 7.2 Repoint the colour tokens, don't rename them

Follow the precedent already set in `evabob_colors.dart` — keep the legacy
names, change what they point at. New values:

| Existing token | New value |
|---|---|
| `pageBg` / `cream` | `#F0FAFF` |
| `sheet` / `mint` | `#FFFFFF` |
| `creamDeep` | `#F0FAFF` (badge wells) |
| `hairline` | `#E6EBEF` — now opaque, not white-at-7% |
| `nearBlack` / `navy` | `#0B1620` |
| `navyMuted` | `#5A6B78` |
| `chalk` | `#64727E` |
| accent (`emerald` and friends) | `#00B5FF` |

Then add `lightDark` `#ACE3FF` and `moneyIn` `#01FFA6` as new names, since
nothing in the old palette corresponds to them.

The `glass*` tokens should be deleted or left unused — there is no translucency
in this design.

### 7.3 Replace the type scale

`Type` in `evabob_tokens.dart` becomes four styles, all `w400`, all inheriting
Numans from the theme:

```dart
static const hero  = TextStyle(fontSize: 48, height: 56/48, letterSpacing: -1.0);
static const title = TextStyle(fontSize: 22, height: 28/22, letterSpacing: -0.2);
static const body  = TextStyle(fontSize: 14, height: 18/14, letterSpacing: -0.1);
static const label = TextStyle(fontSize: 10, height: 14/10, letterSpacing:  0.2);

static const section = TextStyle(          // UPPERCASE at the call site
  fontSize: 10, height: 14/10, letterSpacing: 0.8);
static const tab = TextStyle(
  fontSize: 10, height: 12/10, letterSpacing: 0.2);
```

Flutter's `height` is a **multiplier of font size**, not a pixel value — hence
the divisions. Getting this wrong is the fastest way to have every list row sit
2px off.

`Type.amount` and `Type.amountSmall` should keep
`fontFeatures: [FontFeature.tabularFigures()]` — columns of amounts jitter
without it as digits change. Check that Numans ships `tnum`; if it does not,
right-align the column and accept the variance rather than switching family.

Delete `heroFraction`, `section`'s old 15px definition, `caption` and `micro` —
there is no 15px, 12px or 11px step in this design, and leaving them available
guarantees they get used.

### 7.4 Radii

`Radii.sm` (12) is correct for cards. `Radii.md` (18), `lg` (24) and `xl` (32)
have no equivalent in this design — the halving instruction means 12 and 16 are
the only card-scale radii. Repoint `md` to 16 for sheets and remove `lg`/`xl`,
or leave them and never call them.

### 7.5 Shadows

`Shadows.card` is `Color(0x0F000000)` — pure black at 6%. The design uses ink at
6% (`0x0F0B1620`). The difference is small but it is the difference between a
shadow that reads neutral-grey and one that carries the page's blue undertone.
Repoint all three, and add `sheet`, `button` and `knob` per §1.5.

---

## 8. Accessibility

- **Contrast that passes:** `ink` on white is ~16.5:1. `sec` on white ~5.3:1.
  `tert` on white ~4.8:1. `blue` on white ~2.9:1 — fine for the 22px+ sizes and
  for non-text UI, but `blue` should not be used for 14px body copy on white
  except as a link, where underline-on-focus or the surrounding context carries
  it.
- **Contrast that does not pass:** `moneyIn` `#01FFA6` on white, ~1.3:1. See
  §1.1.1 — accepted deliberately, information is redundant.
- **Touch targets:** the 40px chips and 44px back button meet the 44pt minimum
  once their tap area is padded. The 28px clear button on Edit handle and the
  6px unread dots do **not** — give them a 44 × 44 `GestureDetector` with
  `behavior: HitTestBehavior.opaque` rather than resizing the visual.
- **Single weight and screen readers:** because there is no bold, visual
  hierarchy is invisible to a screen reader. Set `Semantics(header: true)` on
  section headers and screen titles explicitly — do not rely on size.
- **Reduced motion:** already handled by `Motion.reduced()`. Honour it.
- **Dynamic type:** support 100–200%. Rows reflow and primary actions grow
  vertically before copy truncates; identifiers use a middle ellipsis where a
  fixed technical value cannot wrap safely.

---

## 9. Completion and remaining scope boundaries

The handoff pass resolved the former design gaps: empty states, loading and
skeleton states, offline and provider failures, failed and unknown payment
outcomes, disabled/loading/pressed controls, long-name and long-amount stress
cases, wallet-copy confirmation, and the missing Profile settings flows are all
represented in the live file. The final copy audit also replaced customer-facing
asset codes with `$`/`€` presentation and converted all 20 public-web testnet
badges into real containers whose centred `TESTNET` label is a child of the
badge frame.

The remaining items are deliberate scope boundaries rather than unfinished
screens:

1. **Dark mode is out of scope.** The dark palette in
   `evabob_colors.dart` is a previous design, not a counterpart to this system.
2. **Native tablet and landscape layouts require implementation QA.** The
   mobile source is 390×844 and safe down to 360px; public payment and claim
   pages cover 360–1440px.
3. **`moneyIn` contrast remains a product decision.** Information is redundant
   in the current treatment, but the colour should be revisited before a
   production accessibility sign-off.
4. **Bank transfer, debit-card top-up and cash-out remain feature-gated.** They
   are collected in `07 · FUTURE — UNAVAILABLE ON TESTNET` and must not appear
   operational until their providers and compliance path exist.
5. **Mainnet and real-value language remain out of scope** until security,
   compliance and provider reviews are complete.

---

## 10. Quick reference card

```
FRAME      390 × 844        MARGIN 20        CONTENT 350 @ x20
CARD       350 wide, r12/0.6, pad 16 → x36, shadow ink@6% y8 b24 s-6
ROW        pitch 72 | badge 40 @ x36 | text x88 | value x240 w110 right
SEP        262×1 @ x88 (badge row) · 306×1 @ x36 (plain row) · #E6EBEF

TYPE       Numans 400 only — no bold, ever
  48/56/-1.0  hero      22/28/-0.2  title
  14/18/-0.1  body      10/14/+0.2  label
  10/14/+0.8  SECTION HEADER, #64727E
  10/12/+0.2  tab label
  Inter 900 = icon glyphs only (‹ › × ⌫ and initials)

COLOUR     #00B5FF accent   #F0FAFF page   #FFFFFF surface
           #0B1620 ink      #5A6B78 sec    #64727E tert   #E6EBEF sep
           #ACE3FF tinted track           #01FFA6 money-in TEXT ONLY
           scrim #0B1620A6                home indicator #0B162047

RADII      card 12 · sheet/tabbar 16 · key 14 · tile 10 · pill 999
           smoothing 0.6 on everything ≥ 8

BUTTON     350×56 @ (20,752) r999 blue, shadow #00B5FF47 y10 b24 s-6
           label 14 white centred @ y771
STATUS     9:41 @ (28,17)         HOME IND  130×5 @ (130,834) r3
BACK       ellipse 44 @ (20,54)   ‹ Inter900 22 @ (20,62)
NAV TITLE  14/18/0 centred w250 @ (70,65)
TABBAR     358×87 @ (16,752) · icons 22 @ y772 · labels @ y798
```
