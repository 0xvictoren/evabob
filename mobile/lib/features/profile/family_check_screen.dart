import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/contacts/contacts_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';

/// Which contacts are family, and above what amount paying them needs the
/// code from email.
///
/// Voice-cloning makes "it's me, I need money now" sound exactly like the
/// person. This is the pause that happens outside the call.
class FamilyCheckScreen extends StatefulWidget {
  const FamilyCheckScreen({super.key});

  @override
  State<FamilyCheckScreen> createState() => _FamilyCheckScreenState();
}

class _FamilyCheckScreenState extends State<FamilyCheckScreen> {
  final _above = TextEditingController();
  double? _saved;
  bool _saving = false;
  final Set<String> _busy = {};

  @override
  void initState() {
    super.initState();
    final contacts = context.read<ContactsService>();
    contacts.refresh();
    contacts.familyCheckAbove().then((v) {
      if (!mounted) return;
      setState(() {
        _saved = v;
        _above.text = v == v.roundToDouble() ? v.toStringAsFixed(0) : '$v';
      });
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _above.dispose();
    super.dispose();
  }

  Future<void> _saveAbove() async {
    final v = double.tryParse(_above.text.trim());
    if (v == null || v < 0) return;
    setState(() => _saving = true);
    try {
      await context.read<ContactsService>().setFamilyCheckAbove(v);
      if (!mounted) return;
      setState(() => _saved = v);
      FocusScope.of(context).unfocus();
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(friendlyError(e)),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _toggle(SavedContact c, bool family) async {
    setState(() => _busy.add(c.id));
    try {
      await context.read<ContactsService>().setFamily(c.id, family);
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(friendlyError(e)),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      if (mounted) setState(() => _busy.remove(c.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final contacts = context.watch<ContactsService>();
    final changed = double.tryParse(_above.text.trim()) != _saved;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Family check',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(
                    Space.page, 0, Space.page, Space.xl),
                children: [
                  Text(
                    'Scammers can copy a voice from a few seconds of video '
                    'and call pretending to be family. When you pay someone '
                    'marked here, above your amount, we email you a code '
                    'first. Enter it before your PIN.',
                    style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                  ),
                  const SizedBox(height: Space.md),
                  Glass(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Ask for the code above',
                            style: Type.body
                                .copyWith(color: EvabobColors.nearBlack)),
                        const SizedBox(height: Space.sm),
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _above,
                                keyboardType:
                                    const TextInputType.numberWithOptions(
                                        decimal: true),
                                inputFormatters: [
                                  const AmountInputFormatter(),
                                ],
                                decoration: const InputDecoration(
                                  prefixText: r'$ ',
                                  hintText: '100',
                                ),
                                onChanged: (_) => setState(() {}),
                              ),
                            ),
                            const SizedBox(width: Space.md),
                            FilledButton(
                              onPressed:
                                  _saving || !changed ? null : _saveAbove,
                              child: const Text('Save'),
                            ),
                          ],
                        ),
                        if (_saved != null) ...[
                          const SizedBox(height: Space.sm),
                          Text(
                            _saved == 0
                                ? 'Every payment to family needs the code.'
                                : 'Payments to family over '
                                    '${formatMoney(_saved!)} need the code.',
                            style: Type.caption
                                .copyWith(color: EvabobColors.navyMuted),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: Space.lg),
                  const EvabobSectionLabel('Family'),
                  const SizedBox(height: Space.sm),
                  if (contacts.items.isEmpty)
                    Text(
                      contacts.loading
                          ? 'Loading your contacts…'
                          : 'You have no saved contacts yet. Save someone '
                              'after paying them, then mark them here.',
                      style: Type.body.copyWith(color: EvabobColors.navyMuted),
                    ),
                  for (final c in contacts.items)
                    Padding(
                      padding: const EdgeInsets.only(bottom: Space.sm),
                      child: Glass(
                        child: Material(
                          type: MaterialType.transparency,
                          child: SwitchListTile(
                            contentPadding: EdgeInsets.zero,
                            value: c.family,
                            onChanged: _busy.contains(c.id)
                                ? null
                                : (v) => _toggle(c, v),
                            activeThumbColor: EvabobColors.emerald,
                            title: Text(c.name,
                                style: Type.body
                                    .copyWith(color: EvabobColors.nearBlack)),
                            subtitle: Text(
                              shortUiText(c.email ?? c.address, max: 30),
                              style: Type.caption
                                  .copyWith(color: EvabobColors.navyMuted),
                            ),
                          ),
                        ),
                      ),
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
