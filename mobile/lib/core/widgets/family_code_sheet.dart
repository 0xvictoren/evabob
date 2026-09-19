import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';
import '../utils/money_format.dart';
import '../utils/text_safe.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// The family check, run between the review sheet and the PIN.
///
/// Voice-clone scams sound exactly like a son or a mother asking for money
/// now. For contacts marked as family, above the amount the person chose, the
/// server emails a 6-digit code to their own account email and will not start
/// the payment without it. Returns true when the payment may go ahead: no
/// check was needed, or the code was entered.
Future<bool> passFamilyCheck(
  BuildContext context, {
  required String to,
  required double amount,
  String token = 'USDC',
}) async {
  final api = context.read<ApiClient>();
  Map<String, dynamic> started;
  try {
    started = await api.post('/v1/family-check/start', body: {
      'to': to,
      'amount': amount,
      'token': token,
    });
  } catch (e) {
    if (context.mounted) {
      showTopSnack(
        context,
        SnackBar(
          content: Text(friendlyError(e,
              fallback: 'Could not check this payment. Try again.')),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
    return false;
  }
  if (started['required'] != true) return true;
  if (!context.mounted) return false;
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _FamilyCodeSheet(
      api: api,
      to: to,
      amount: amount,
      token: token,
      sentTo: started['sentTo']?.toString() ?? 'your email',
      contactName: started['contactName']?.toString(),
      emailSent: started['emailSent'] != false,
    ),
  );
  return ok == true;
}

class _FamilyCodeSheet extends StatefulWidget {
  const _FamilyCodeSheet({
    required this.api,
    required this.to,
    required this.amount,
    required this.token,
    required this.sentTo,
    required this.emailSent,
    this.contactName,
  });

  final ApiClient api;
  final String to;
  final double amount;
  final String token;
  final String sentTo;
  final String? contactName;
  final bool emailSent;

  @override
  State<_FamilyCodeSheet> createState() => _FamilyCodeSheetState();
}

class _FamilyCodeSheetState extends State<_FamilyCodeSheet> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _info;
  int _resendIn = 30;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    if (!widget.emailSent) {
      _info = 'The email could not be sent. Ask for a new code.';
      _resendIn = 0;
    }
    _startTimer();
  }

  void _startTimer() {
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted || _resendIn <= 0) return t.cancel();
      setState(() => _resendIn--);
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    final code = _code.text.trim();
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      setState(() => _error = 'Enter the 6 digits from the email.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.post('/v1/family-check/verify', body: {'code': code});
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    setState(() {
      _busy = true;
      _error = null;
      _info = null;
    });
    try {
      final res = await widget.api.post('/v1/family-check/start', body: {
        'to': widget.to,
        'amount': widget.amount,
        'token': widget.token,
      });
      if (!mounted) return;
      setState(() {
        _info = res['emailSent'] == false
            ? 'The email could not be sent. Try again in a moment.'
            : 'A new code is on its way.';
        _resendIn = 30;
        _code.clear();
      });
      _startTimer();
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final who = widget.contactName ?? 'family';
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Container(
          margin: const EdgeInsets.all(Space.md),
          padding:
              const EdgeInsets.fromLTRB(Space.lg, Space.lg, Space.lg, Space.md),
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.lg),
            boxShadow: Shadows.raised,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Paying $who',
                style: Type.title.copyWith(color: EvabobColors.nearBlack),
              ),
              const SizedBox(height: Space.sm),
              Text(
                'You marked $who as family, so ${formatMoney(widget.amount, widget.token)} '
                'needs the code we emailed to ${widget.sentTo}.',
                style: Type.body.copyWith(color: EvabobColors.navyMuted),
              ),
              const SizedBox(height: Space.md),
              Container(
                padding: const EdgeInsets.all(Space.md),
                decoration: BoxDecoration(
                  color: EvabobColors.danger.withValues(alpha: 0.08),
                  borderRadius: Radii.all(Radii.sm),
                ),
                child: Text(
                  'Did a call or message ask for this money urgently? Hang up '
                  'and call them back on the number you already have. Voices '
                  'can be faked. Never read this code out to anyone.',
                  style: Type.caption.copyWith(color: EvabobColors.nearBlack),
                ),
              ),
              const SizedBox(height: Space.lg),
              TextField(
                controller: _code,
                autofocus: true,
                keyboardType: TextInputType.number,
                maxLength: 6,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 28, letterSpacing: 10),
                decoration: const InputDecoration(
                  counterText: '',
                  hintText: '······',
                ),
                onSubmitted: (_) => _verify(),
              ),
              if (_error != null) ...[
                const SizedBox(height: Space.sm),
                Text(_error!,
                    style: Type.caption.copyWith(color: EvabobColors.alert)),
              ],
              if (_info != null) ...[
                const SizedBox(height: Space.sm),
                Text(_info!,
                    style:
                        Type.caption.copyWith(color: EvabobColors.navyMuted)),
              ],
              const SizedBox(height: Space.md),
              Row(
                children: [
                  Expanded(
                    child: TextButton(
                      onPressed: _busy || _resendIn > 0 ? null : _resend,
                      child: Text(
                        _resendIn > 0
                            ? 'New code in ${_resendIn}s'
                            : 'Send a new code',
                      ),
                    ),
                  ),
                  const SizedBox(width: Space.md),
                  Expanded(
                    child: FilledButton(
                      onPressed: _busy ? null : _verify,
                      child: _busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Continue'),
                    ),
                  ),
                ],
              ),
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: Text(
                  'Don\'t pay',
                  style: Type.label.copyWith(color: EvabobColors.navyMuted),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
