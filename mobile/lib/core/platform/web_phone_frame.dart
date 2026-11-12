import 'package:flutter/material.dart';

import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';
import '../widgets/glass.dart';

/// Where the website's sidebar asks the app to go. The shell listens.
///
/// The sidebar sits outside the navigator (it has to, to stay put while
/// screens change), so it cannot call the shell directly. It writes a
/// destination here instead: "tab:0", "market", "send", "request", "profile".
class ShellNav {
  ShellNav._();

  /// The next place to go; the shell clears it once it has gone there.
  static final ValueNotifier<String?> request = ValueNotifier<String?>(null);

  /// What the sidebar shows as selected.
  static final ValueNotifier<String> current = ValueNotifier<String>('tab:0');

  static void go(String destination) {
    current.value = destination;
    request.value = destination;
  }
}

/// Whether the app is being shown as a website with a sidebar. Screens that
/// carry their own navigation (the shell's bottom bar) read this to hide it.
class WebLayout extends InheritedWidget {
  const WebLayout({super.key, required this.sidebar, required super.child});

  final bool sidebar;

  static bool hasSidebar(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<WebLayout>()?.sidebar ?? false;

  @override
  bool updateShouldNotify(WebLayout oldWidget) => sidebar != oldWidget.sidebar;
}

/// The app in a browser.
///
///   a phone or a narrow window   the app edge to edge, exactly as on phones
///   a medium window              the app at phone width, centred
///   a laptop or desktop          a website: a sidebar on the left that stays
///                                put, and the screens in a wide column beside
///                                it, so lists can use two columns
///
/// Screens size themselves from [MediaQuery], so the frame reports the width
/// of the column it gives them — dialogs and sheets open inside it too.
class WebPhoneFrame extends StatelessWidget {
  const WebPhoneFrame({
    super.key,
    required this.child,
    this.signedIn = false,
    this.onNavigate,
  });

  final Widget child;

  /// The sidebar is only for someone who is in; sign-in stays a centred card.
  final bool signedIn;

  /// Called before a sidebar destination is requested, to close whatever
  /// screens are open on top (the app pops its navigator to the shell).
  final VoidCallback? onNavigate;

  static const _phoneWidth = 430.0;
  static const _frameFrom = 560.0;
  static const _siteFrom = 1000.0;
  static const _sidebarWidth = 264.0;
  static const _contentMax = 880.0;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final width = media.size.width;
    final height = media.size.height;
    if (width < _frameFrom) return WebLayout(sidebar: false, child: child);

    if (width < _siteFrom || !signedIn) {
      return WebLayout(
        sidebar: false,
        child: ColoredBox(
          color: EvabobColors.black,
          child: Center(
            child: SizedBox(
              width: _phoneWidth,
              height: height,
              child: MediaQuery(
                data: media.copyWith(size: Size(_phoneWidth, height)),
                child: ClipRect(child: child),
              ),
            ),
          ),
        ),
      );
    }

    final room = width - _sidebarWidth;
    final content = room > _contentMax ? _contentMax : room;
    return WebLayout(
      sidebar: true,
      child: ColoredBox(
        color: EvabobColors.pageBg,
        child: Row(
          children: [
            SizedBox(
              width: _sidebarWidth,
              height: height,
              child: _Sidebar(onNavigate: onNavigate),
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: Center(
                child: SizedBox(
                  width: content,
                  height: height,
                  child: MediaQuery(
                    data: media.copyWith(size: Size(content, height)),
                    child: ClipRect(child: child),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({this.onNavigate});

  final VoidCallback? onNavigate;

  static const _items = [
    ('tab:0', Icons.home_rounded, 'Home'),
    ('market', Icons.storefront_rounded, 'Marketplace'),
    ('tab:1', Icons.chat_bubble_rounded, 'Chat'),
    ('tab:3', Icons.receipt_long_rounded, 'Activity'),
    ('tab:4', Icons.account_balance_wallet_rounded, 'Wallet'),
    ('request', Icons.request_quote_rounded, 'Get paid'),
  ];

  void _go(String destination) {
    onNavigate?.call();
    ShellNav.go(destination);
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: EvabobColors.sheet,
      child: ValueListenableBuilder<String>(
        valueListenable: ShellNav.current,
        builder: (context, current, _) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 24, 16, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 24),
                child: Row(
                  children: [
                    ClipRRect(
                      borderRadius: Radii.all(8),
                      child: Image.asset('assets/logo.png',
                          width: 32, height: 32, fit: BoxFit.cover),
                    ),
                    const SizedBox(width: 10),
                    Text('evabob',
                        style: Type.title.copyWith(color: EvabobColors.ink)),
                  ],
                ),
              ),
              for (final item in _items)
                _SidebarItem(
                  icon: item.$2,
                  label: item.$3,
                  selected: current == item.$1,
                  onTap: () => _go(item.$1),
                ),
              const SizedBox(height: 16),
              PressScale(
                onTap: () => _go('send'),
                child: Container(
                  height: 48,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: EvabobColors.primary,
                    borderRadius: Radii.all(Radii.pill),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.north_east_rounded,
                          size: 18, color: EvabobColors.white),
                      const SizedBox(width: 8),
                      Text('Send money',
                          style:
                              Type.body.copyWith(color: EvabobColors.white)),
                    ],
                  ),
                ),
              ),
              const Spacer(),
              _SidebarItem(
                icon: Icons.person_rounded,
                label: 'Profile',
                selected: current == 'profile',
                onTap: () => _go('profile'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SidebarItem extends StatelessWidget {
  const _SidebarItem({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? EvabobColors.primary : EvabobColors.inkMuted;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Semantics(
        button: true,
        selected: selected,
        label: label,
        excludeSemantics: true,
        child: InkWell(
          borderRadius: Radii.all(12),
          onTap: onTap,
          child: AnimatedContainer(
            duration: Motion.fast,
            height: 46,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: selected ? EvabobColors.pageBg : Colors.transparent,
              borderRadius: Radii.all(12),
            ),
            child: Row(
              children: [
                Icon(icon, size: 20, color: color),
                const SizedBox(width: 12),
                Text(
                  label,
                  style: Type.body.copyWith(
                    color: selected ? EvabobColors.ink : EvabobColors.inkMuted,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
