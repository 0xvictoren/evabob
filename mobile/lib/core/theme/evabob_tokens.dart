import 'package:flutter/material.dart';

import 'evabob_colors.dart';

/// Spacing, radius, type and motion tokens.
///
/// The palette was already centralised; everything else was not. Sizes and
/// weights were written inline at several hundred call sites, which is why the
/// app reads as three different products depending on the screen. These exist
/// so a change lands everywhere rather than wherever someone remembers to look.
///
/// Kept deliberately small. A scale nobody can hold in their head gets ignored
/// and the inline values come back.
class Space {
  Space._();

  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const page = 20.0;
  static const xl = 24.0;
  static const xxl = 32.0;
}

/// "Generous rounded corners everywhere" (brief, Section 2).
class Radii {
  Radii._();

  static const sm = 12.0;
  static const md = 16.0;
  static const lg = 16.0;
  static const xl = 16.0;

  /// Pills and circular buttons.
  static const pill = 999.0;

  static BorderRadius all(double r) => BorderRadius.circular(r);
}

/// Soft, low-opacity shadows instead of hard borders (brief, Section 2).
class Shadows {
  Shadows._();

  static const card = [
    BoxShadow(
      color: Color(0x0F0B1620),
      blurRadius: 24,
      spreadRadius: -6,
      offset: Offset(0, 8),
    ),
  ];

  static const raised = [
    BoxShadow(color: Color(0x140B1620), blurRadius: 32, offset: Offset(0, 12)),
  ];

  static const subtle = [
    BoxShadow(color: Color(0x0F0B1620), blurRadius: 12, offset: Offset(0, 4)),
  ];

  static const sheet = [
    BoxShadow(color: Color(0x290B1620), blurRadius: 40, offset: Offset(0, -8)),
  ];

  static List<BoxShadow> get button => [
    BoxShadow(
      color: EvabobColors.buttonGlow,
      blurRadius: 24,
      spreadRadius: -6,
      offset: Offset(0, 10),
    ),
  ];

  static const knob = [
    BoxShadow(color: Color(0x290B1620), blurRadius: 4, offset: Offset(0, 2)),
  ];
}

/// The type scale.
///
/// `fontFamily` is left null so every style inherits Numans from the theme.
/// The sizes, weights and tracking below carry the intended hierarchy.
class Type {
  Type._();

  static const hero = TextStyle(
    fontSize: 48,
    fontWeight: FontWeight.w400,
    letterSpacing: -1,
    height: 56 / 48,
  );

  static const heroFraction = hero;

  static const title = TextStyle(
    fontSize: 22,
    fontWeight: FontWeight.w400,
    letterSpacing: -0.2,
    height: 28 / 22,
  );

  static const section = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w400,
    letterSpacing: 0.8,
    height: 14 / 10,
  );

  static const body = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w400,
    height: 18 / 14,
    letterSpacing: -0.1,
  );

  static const label = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w400,
    height: 14 / 10,
    letterSpacing: 0.2,
  );

  static const caption = label;

  static const micro = label;

  static const tab = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w400,
    height: 12 / 10,
    letterSpacing: 0.2,
  );

  /// Amounts and timestamps. Tabular figures stop columns of numbers from
  /// jittering as digits change, which is the whole reason to ask for them.
  static const amount = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w400,
    letterSpacing: -0.1,
    height: 18 / 14,
    fontFeatures: [FontFeature.tabularFigures()],
  );

  static const amountSmall = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w400,
    height: 14 / 10,
    letterSpacing: 0.2,
    fontFeatures: [FontFeature.tabularFigures()],
  );
}

/// Motion.
///
/// "Spring easing with slight overshoot… pulled up and rubber-banded into
/// place, not slid on rails" (brief, Section 2). The overshoot is the point;
/// a standard ease reads as a different app.
class Motion {
  Motion._();

  static const fast = Duration(milliseconds: 180);
  static const base = Duration(milliseconds: 320);
  static const slow = Duration(milliseconds: 520);

  /// Overshoots slightly, then settles.
  static const spring = Cubic(0.34, 1.4, 0.36, 1.0);

  /// For things that must not overshoot — a value counting up, a crossfade.
  static const smooth = Cubic(0.32, 0.72, 0, 1);

  /// Press feedback: scale to ~0.96 and spring back.
  static const pressScale = 0.96;

  /// Stagger between list items rising in.
  static const stagger = Duration(milliseconds: 45);

  /// Whether to animate at all.
  ///
  /// Honouring this is not decoration: for someone with vestibular sensitivity
  /// a springing, overshooting interface is genuinely unpleasant, and the brief
  /// asks for a plain crossfade instead.
  static bool reduced(BuildContext context) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;
}
