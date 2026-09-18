import 'package:evabob_mobile/core/held/held_payments_api.dart';
import 'package:evabob_mobile/core/held/operator_reviews_api.dart';
import 'package:evabob_mobile/core/wallet/payee_check.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('held payment', () {
    test('reads the server view, including the review', () {
      final h = HeldPayment.fromJson({
        'transferId': '7',
        'purpose': 'job',
        'role': 'worker',
        'stage': 'under_review',
        'actions': ['respond', 'give_back'],
        'amountUsdc': 50,
        'memo': 'logo',
        'counterparty': '@maya',
        'expiresAt': '2026-12-01T00:00:00Z',
        'deliveredAt': '2026-09-18T10:00:00Z',
        'deliveryLinks': ['https://files.example.com/logo'],
        'review': {
          'status': 'under_review',
          'reason': 'not_as_agreed',
          'details': 'The colours were not the ones we agreed on.',
        },
      });
      expect(h.stage, HeldStage.underReview);
      expect(h.isPayer, isFalse);
      expect(h.can('respond'), isTrue);
      expect(h.review?.reason, CancelReason.notAsAgreed);
      expect(h.review?.open, isTrue);
      expect(h.deliveryLinks.single, 'https://files.example.com/logo');
    });

    test('flags what needs the person now', () {
      HeldPayment of(String role, String stage, List<String> actions,
              {String purpose = 'job'}) =>
          HeldPayment.fromJson({
            'transferId': '1',
            'purpose': purpose,
            'role': role,
            'stage': stage,
            'actions': actions,
            'amountUsdc': 5,
            'counterparty': 'x',
          });
      // A worker who has not delivered, a payer with work to check, a worker
      // under review, and a sender still inside a cooling-off window.
      expect(of('worker', 'waiting_for_delivery', ['mark_delivered']).needsMe,
          isTrue);
      expect(of('payer', 'delivered', ['confirm']).needsMe, isTrue);
      expect(of('worker', 'under_review', ['respond']).needsMe, isTrue);
      expect(
          of('payer', 'cooling_off', ['cancel'], purpose: 'cooling_off')
              .needsMe,
          isTrue);
      // Waiting on the other side is not this person's to do.
      expect(of('payer', 'waiting_for_delivery', ['confirm', 'cancel']).needsMe,
          isFalse);
      expect(of('worker', 'delivered', ['give_back']).needsMe, isFalse);
    });

    test('settled stages are settled', () {
      expect(HeldStage.parse('released').settled, isTrue);
      expect(HeldStage.parse('refunded').settled, isTrue);
      expect(HeldStage.parse('delivered').settled, isFalse);
      expect(HeldStage.parse('something new'), HeldStage.unknown);
    });
  });

  group('payee check', () {
    test('turns the server warnings into plain cautions, strongest first', () {
      final c = PayeeCheck.fromJson({
        'label': '0x1111…2222',
        'address': '0x1111bbbb99999999999999999999999999992222',
        'isEvabobUser': false,
        'paidBefore': false,
        'warnings': [
          'first_payment',
          'raw_address_new',
          'raw_address_not_evabob',
          'looks_like_known_address',
        ],
        'resembles': '0x1111aaaa00000000000000000000000000002222',
        'coolingOff': {'available': false, 'recommended': false, 'minutes': 10},
      });
      expect(c.cautions.length, 2);
      expect(c.cautions.first, contains('looks like one you have paid'));
      expect(c.coolingOffAvailable, isFalse);
    });

    test('carries the cooling-off offer and who to hold it for', () {
      final c = PayeeCheck.fromJson({
        'label': '@maya',
        'address': '0x3333000000000000000000000000000000004444',
        'displayName': 'Maya',
        'isEvabobUser': true,
        'paidBefore': false,
        'warnings': ['first_payment'],
        'coolingOff': {
          'available': true,
          'recipient': '@maya',
          'recommended': true,
          'minutes': 10,
        },
      });
      expect(c.cautions, isEmpty);
      expect(c.coolingOffRecommended, isTrue);
      expect(c.holdRecipient, '@maya');
      expect(c.coolingOffMinutes, 10);
    });
  });

  group('operator review', () {
    test('reads both sides and knows when it is still open', () {
      final r = OperatorReview.fromJson({
        'transferId': '12',
        'amountUsdc': 40,
        'payer': 'ada',
        'recipient': 'bola',
        'status': 'pending',
        'deliveredAt': '2026-09-18T10:00:00Z',
        'deliveryNote': 'Logo files in three sizes',
        'deliveryLinks': ['https://files.example.com/logo'],
        'review': {
          'status': 'under_review',
          'openedAt': '2026-09-19T09:00:00Z',
          'reason': 'no_longer_needed',
          'details': 'The event was cancelled, we do not need the posters.',
          'workerStatement': 'Delivered on time as agreed in the chat.',
        },
      });
      expect(r.payer, '@ada');
      expect(r.open, isTrue);
      expect(r.review.reason, CancelReason.noLongerNeeded);
      expect(r.review.openedAt, isNotNull);
      expect(r.review.workerStatement, contains('on time'));
    });

    test('a decided review is no longer open', () {
      final r = OperatorReview.fromJson({
        'transferId': '12',
        'amountUsdc': 40,
        'status': 'claimed',
        'review': {'status': 'released_to_worker', 'details': 'x'},
      });
      expect(r.open, isFalse);
      expect(r.payer, 'the payer');
    });
  });
}
