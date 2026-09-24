import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/chat/chat_service.dart';
import '../../core/utils/text_safe.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/widgets/motion.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/bundle_avatar.dart';
import '../../core/widgets/glass.dart';
import 'chat_thread_screen.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:intl/intl.dart';
import '../../core/chat/chat_models.dart';
import '../../core/utils/handles.dart';
import '../../core/widgets/themed_svg.dart';

class ChatListScreen extends StatefulWidget {
  const ChatListScreen({super.key});

  @override
  State<ChatListScreen> createState() => _ChatListScreenState();
}

class _ChatListScreenState extends State<ChatListScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<ChatService>().refreshThreads();
    });
  }

  Future<void> _newConversation() async {
    final handleCtrl = TextEditingController();
    final choice = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(ctx).bottom + 16,
            left: 16,
            right: 16,
            top: 16,
          ),
          child: Glass(
            heavy: true,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'New conversation',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Find someone by their @username.',
                  style: TextStyle(
                    fontSize: 10,
                    color: EvabobColors.navyMuted,
                  ),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: handleCtrl,
                  autofocus: true,
                  decoration: const InputDecoration(
                    labelText: '@username',
                    hintText: '@adaobi',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.alternate_email_rounded),
                  ),
                  onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => Navigator.pop(ctx, handleCtrl.text.trim()),
                  child: const Text('Start chat'),
                ),
              ],
            ),
          ),
        );
      },
    );
    if (choice == null || choice.isEmpty || !mounted) return;

    final chat = context.read<ChatService>();
    try {
      final thread = await chat.startThread(peer: choice);
      if (!mounted || thread == null) return;
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ChatThreadScreen(thread: thread),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content:
              Text(friendlyError(e, fallback: 'Could not open that chat.')),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  /// Filters the list as they type; Enter on a handle, email or address
  /// starts a conversation with that person.
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _openWith(String peer) async {
    final who = normalizePayee(peer);
    if (who.isEmpty) return;
    final chat = context.read<ChatService>();
    try {
      final thread = await chat.startThread(peer: who);
      if (!mounted || thread == null) return;
      _search.clear();
      await Navigator.of(context).push(
        SpringPageRoute(page: ChatThreadScreen(thread: thread)),
      );
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content:
              Text(friendlyError(e, fallback: 'Could not open that chat.')),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  static String _when(DateTime? at) {
    if (at == null) return '';
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(at.year, at.month, at.day);
    final days = today.difference(day).inDays;
    if (days <= 0) return DateFormat('HH:mm').format(at);
    if (days == 1) return 'Yesterday';
    if (days < 7) return DateFormat('EEE').format(at);
    return DateFormat('d MMM').format(at);
  }

  void _open(ChatThread t) {
    Navigator.of(context)
        .push(SpringPageRoute(page: ChatThreadScreen(thread: t)));
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<ChatService>();
    final q = _search.text.trim().toLowerCase().replaceFirst('@', '');
    final agent = chat.threads.where((t) => t.isAgent).firstOrNull;
    final people = chat.threads
        .where((t) => !t.isAgent)
        .where((t) =>
            q.isEmpty ||
            t.title.toLowerCase().contains(q) ||
            (t.handle ?? '').toLowerCase().contains(q))
        .toList();

    // Figma "Chat · List" (2:148).
    return SafeArea(
      bottom: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 120),
        children: [
          Row(
            children: [
              Text(
                'Chat',
                style: Type.title.copyWith(
                  fontSize: 24,
                  height: 32 / 24,
                  letterSpacing: -0.4,
                ),
              ),
              const Spacer(),
              Semantics(
                button: true,
                label: 'New conversation',
                child: GestureDetector(
                  onTap: _newConversation,
                  child: SizedBox(
                    width: 40,
                    height: 40,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        ThemedSvg('assets/figma/btn_new_chat.svg',
                            width: 40, height: 40),
                        Text(
                          '+',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontWeight: FontWeight.w900,
                            fontSize: 20,
                            height: 26 / 20,
                            color: EvabobColors.pageBg,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 4),
            ],
          ),
          const SizedBox(height: 22),
          Container(
            height: 44,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            decoration: BoxDecoration(
              color: EvabobColors.white,
              borderRadius: BorderRadius.circular(999),
            ),
            alignment: Alignment.centerLeft,
            child: TextField(
              controller: _search,
              onChanged: (_) => setState(() {}),
              onSubmitted: _openWith,
              textInputAction: TextInputAction.go,
              style: Type.body,
              decoration: InputDecoration(
                isCollapsed: true,
                filled: false,
                contentPadding: EdgeInsets.zero,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                hintText: '@handle, email or wallet address',
                hintStyle: Type.body.copyWith(color: EvabobColors.blueSoft),
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (q.isEmpty)
            GestureDetector(
              onTap: agent == null ? null : () => _open(agent),
              child: Container(
                padding: const EdgeInsets.fromLTRB(16, 22, 16, 22),
                decoration: BoxDecoration(
                  color: EvabobColors.white,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    SizedBox(
                      width: 48,
                      height: 48,
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          ThemedSvg('assets/figma/avatar_agent.svg',
                              width: 48, height: 48),
                          Text(
                            'eb',
                            style: Type.body.copyWith(
                              color: EvabobColors.white,
                              letterSpacing: 0,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Evabob', style: Type.body),
                          const SizedBox(height: 6),
                          Text(
                            'You can send money, swap currency or check your balance - just ask.',
                            style: Type.label.copyWith(
                              color: EvabobColors.slate,
                              height: 15 / 10,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if ((agent?.unread ?? 0) > 0)
                      _UnreadDot(count: agent!.unread),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 24),
          Text(
            'PEOPLE',
            style: Type.section.copyWith(color: EvabobColors.inkTertiary),
          ),
          const SizedBox(height: 12),
          if (chat.loading && chat.threads.isEmpty)
            const Padding(
              padding: EdgeInsets.all(32),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (people.isEmpty)
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: EvabobColors.white,
                borderRadius: BorderRadius.circular(12),
                boxShadow: Shadows.card,
              ),
              child: Text(
                q.isEmpty
                    ? 'No conversations yet. Search for someone above to start one.'
                    : 'No one here matches. Press enter to start a chat with $q.',
                style: Type.label.copyWith(color: EvabobColors.slate),
              ),
            )
          else
            Container(
              padding: const EdgeInsets.fromLTRB(16, 4, 20, 20),
              decoration: BoxDecoration(
                color: EvabobColors.white,
                borderRadius: BorderRadius.circular(12),
                boxShadow: Shadows.card,
              ),
              child: Column(
                children: [
                  for (var i = 0; i < people.length; i++) ...[
                    if (i > 0)
                      const Padding(
                        padding: EdgeInsets.only(left: 56),
                        child: Divider(height: 1, color: EvabobColors.hairline),
                      ),
                    _ThreadRow(
                      thread: people[i],
                      when: _when(people[i].updatedAt),
                      onTap: () => _open(people[i]),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _ThreadRow extends StatelessWidget {
  const _ThreadRow({
    required this.thread,
    required this.when,
    required this.onTap,
  });

  final ChatThread thread;
  final String when;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = thread;
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 75,
        child: Row(
          children: [
            PeerAvatar(
              name: t.title,
              avatarUrl: t.peerAvatarUrl,
              bundleIndex: t.peerAvatarBundle,
              size: 44,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          t.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Type.body,
                        ),
                      ),
                      Text(
                        when,
                        style: Type.label
                            .copyWith(color: EvabobColors.inkTertiary),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          t.isPending
                              ? 'Invitation · approval required'
                              : t.subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Type.label.copyWith(color: EvabobColors.slate),
                        ),
                      ),
                      if (t.unread > 0) _UnreadDot(count: t.unread),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _UnreadDot extends StatelessWidget {
  const _UnreadDot({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 8),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: EvabobColors.blue,
        borderRadius: BorderRadius.all(Radius.circular(999)),
      ),
      child: Text(
        '$count',
        style: Type.label.copyWith(color: EvabobColors.white),
      ),
    );
  }
}
