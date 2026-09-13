import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/chat/chat_service.dart';
import '../../core/utils/text_safe.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/widgets/motion.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/contact_picker_sheet.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/agent_avatar.dart';
import 'chat_thread_screen.dart';

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
                  'Find someone by @username or email.',
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
                    labelText: '@username or email',
                    hintText: '@adaobi',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.alternate_email_rounded),
                  ),
                  onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () async {
                    final picked = await ContactPickerSheet.open(ctx);
                    if (picked != null && picked.isNotEmpty && ctx.mounted) {
                      if (!picked.contains('@') || picked.startsWith('@')) {
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          const SnackBar(
                            content: Text(
                              'Pick a contact with an email. Phone is not a payee.',
                            ),
                            behavior: SnackBarBehavior.floating,
                          ),
                        );
                        return;
                      }
                      Navigator.pop(
                        ctx,
                        picked.replaceAll(RegExp(r'\s+'), '').trim(),
                      );
                    }
                  },
                  icon: const Icon(Icons.contacts_outlined),
                  label: const Text('Pick email from contacts'),
                ),
                const SizedBox(height: 8),
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
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content:
              Text(friendlyError(e, fallback: 'Could not open that chat.')),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<ChatService>();

    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 12, 12, 8),
            child: Row(
              children: [
                IconButton(
                  tooltip: 'New conversation',
                  onPressed: _newConversation,
                  icon: Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: EvabobColors.emerald.withValues(alpha: 0.15),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.add_rounded,
                      color: EvabobColors.emeraldDeep,
                    ),
                  ),
                ),
                const Text(
                  'Chat',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                  ),
                ),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(Space.page, 0, Space.page, Space.md),
            child: Text(
              'Ask Evabob to send money, convert currency, or check your '
              'balance — in your own words.',
              style: TextStyle(color: EvabobColors.navyMuted, fontSize: 10),
            ),
          ),
          Expanded(
            child: chat.loading && chat.threads.isEmpty
                ? const Center(child: CircularProgressIndicator())
                // With no threads this was a header and then blank space —
                // nothing to read and nothing to tap.
                : chat.threads.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.fromLTRB(
                            Space.page, Space.xl, Space.page, Space.page),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'No conversations yet.',
                              style: Type.section
                                  .copyWith(color: EvabobColors.nearBlack),
                            ),
                            const SizedBox(height: Space.sm),
                            Text(
                              'Start one with someone you want to pay, or ask '
                              'Evabob a question.',
                              style: Type.body
                                  .copyWith(color: EvabobColors.navyMuted),
                            ),
                          ],
                        ),
                      )
                    : ListView.separated(
                        padding: const EdgeInsets.fromLTRB(
                            Space.page, 0, Space.page, 100),
                        itemCount: chat.threads.length,
                        separatorBuilder: (_, __) =>
                            const SizedBox(height: Space.sm),
                        itemBuilder: (context, i) {
                          final t = chat.threads[i];
                          final letter = t.title.isNotEmpty
                              ? t.title.characters.first
                              : '?';
                          return RiseIn(
                            index: i,
                            child: PressScale(
                              scale: Motion.pressScale,
                              onTap: () {
                                Navigator.of(context).push(
                                  SpringPageRoute(
                                      page: ChatThreadScreen(thread: t)),
                                );
                              },
                              child: Container(
                                decoration: BoxDecoration(
                                  // The assistant is pinned and tinted, so it reads
                                  // as part of the app rather than as a contact.
                                  color: t.isAgent
                                      ? EvabobColors.mint
                                      : EvabobColors.sheet,
                                  borderRadius: Radii.all(Radii.md),
                                  boxShadow: Shadows.subtle,
                                ),
                                padding: const EdgeInsets.all(Space.md),
                                child: Row(
                                  children: [
                                    t.isAgent
                                        ? const EvabobAgentAvatar(size: 40)
                                        : CircleAvatar(
                                            backgroundColor: t.isAgent
                                                ? EvabobColors.lime
                                                    .withValues(alpha: 0.25)
                                                : EvabobColors.creamDeep,
                                            child: Text(
                                              letter.toUpperCase(),
                                              style: Type.label.copyWith(
                                                color: EvabobColors.forest,
                                              ),
                                            ),
                                          ),
                                    const SizedBox(width: Space.md),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            t.title,
                                            style: Type.label.copyWith(
                                              color: EvabobColors.nearBlack,
                                            ),
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            t.subtitle,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: Type.caption.copyWith(
                                              color: EvabobColors.navyMuted,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    if (t.unread > 0)
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                            horizontal: Space.sm,
                                            vertical: Space.xs),
                                        decoration: BoxDecoration(
                                          color: EvabobColors.lime,
                                          borderRadius: Radii.all(Radii.pill),
                                        ),
                                        child: Text(
                                          '${t.unread}',
                                          style: Type.micro.copyWith(
                                            color: EvabobColors.forest,
                                            fontWeight: FontWeight.w400,
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
