import 'package:evabob_mobile/core/groups/groups_api.dart';
import 'package:evabob_mobile/core/held/held_payments_api.dart';
import 'package:evabob_mobile/core/held/hold_links_api.dart';
import 'package:evabob_mobile/core/wallet/payee_check.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('money circle', () {
    final circle = MoneyCircle.fromJson({
      'kind': 'circle',
      'id': 'c_abc',
      'name': 'Friday ajo',
      'state': 'running',
      'organizer': '@ada',
      'contributionUsdc': 10,
      'everyWords': 'every week',
      'rounds': 3,
      'roundsCollected': 1,
      'potUsdc': 30,
      'commitmentUsdc': 30,
      'nextCollectionAt': '2026-09-25T12:00:00Z',
      'members': [
        {
          'userId': 'a',
          'name': '@ada',
          'joined': true,
          'behindUsdc': 0,
          'place': null,
          'paidOut': {'round': 1, 'amountUsdc': 29.985},
        },
        {'userId': 'b', 'name': '@bola', 'joined': true, 'behindUsdc': 10, 'place': 2},
        {'userId': 'c', 'name': '@chidi', 'joined': true, 'behindUsdc': 0, 'place': 1},
      ],
      'me': {'userId': 'b', 'name': '@bola', 'joined': true, 'behindUsdc': 10, 'place': 2},
      'history': [
        {'round': 1, 'recipient': '@ada', 'amountUsdc': 19.99, 'missed': ['@bola'], 'at': '2026-09-18T12:00:00Z'},
      ],
    });

    test('reads who is paid, who is next and who is behind', () {
      expect(circle.members.first.paid, isTrue);
      expect(circle.members.first.paidRound, 1);
      expect(circle.me?.behind, isTrue);
      expect(circle.members[2].place, 1);
      expect(circle.history.single.missed, ['@bola']);
      expect(circle.needsMyJoin, isFalse);
    });

    test('a forming circle asks a member who has not joined', () {
      final forming = MoneyCircle.fromJson({
        'id': 'c_x',
        'state': 'forming',
        'members': const [],
        'history': const [],
        'me': {'userId': 'b', 'name': '@bola', 'joined': false, 'behindUsdc': 0},
      });
      expect(forming.needsMyJoin, isTrue);
    });

    test('groups are told apart by kind', () {
      expect(groupFromJson({'kind': 'circle', 'id': 'c_1'}), isA<CircleGroup>());
      expect(groupFromJson({'kind': 'pot', 'id': 'p_1'}), isA<PotGroup>());
    });
  });

  group('collection', () {
    test('progress never goes past full', () {
      final pot = GroupPot.fromJson({
        'id': 'p_1',
        'title': 'Hospital bill',
        'state': 'released',
        'targetUsdc': 100,
        'raisedUsdc': 130,
        'deadline': '2026-10-01T00:00:00Z',
        'contributors': 4,
      });
      expect(pot.progress, 1.0);
      expect(pot.open, isFalse);
    });
  });

  group('hold links', () {
    test('a seller with no finished orders says so plainly', () {
      expect(const SellerRecord().summary, 'No finished orders yet');
      expect(
        SellerRecord.fromJson({'delivered': 12, 'notDelivered': 1, 'refundedAfterReview': 0}).summary,
        '12 delivered · 1 not delivered · 0 refunded after review',
      );
    });

    test('the buyer sees the seller by first name', () {
      final link = PublicHoldLink.fromJson({
        'id': 'abc',
        'title': 'Ankara dress',
        'amount': 45,
        'deliveryDays': 14,
        'active': true,
        'seller': {'name': 'Ada Obi', 'handle': '@adashop', 'avatarUrl': null},
        'record': {'delivered': 3},
      });
      expect(link.sellerFirstName, 'Ada');
      expect(link.record.delivered, 3);
      expect(link.sellerAvatarUrl, isNull);
    });
  });

  group('review conversation', () {
    test('messages carry their evidence', () {
      final review = HeldReview.fromJson({
        'status': 'under_review',
        'reason': 'not_as_agreed',
        'details': 'Wrong colour',
        'messages': [
          {
            'id': 'm1',
            'from': 'payer',
            'text': 'See the photo',
            'photos': ['/uploads/evidence_${'a' * 32}.jpg'],
            'links': const [],
            'at': '2026-09-18T12:00:00Z',
          },
          {'id': 'm2', 'from': 'reviewer', 'text': 'Which courier?', 'at': '2026-09-18T13:00:00Z'},
        ],
      });
      expect(review.messages.length, 2);
      expect(review.messages.first.photos.single, contains('evidence_'));
      expect(review.messages.last.from, 'reviewer');
    });
  });

  group('payee check', () {
    test('knows a family contact and their photo', () {
      final c = PayeeCheck.fromJson({
        'label': '@mum',
        'address': '0x1111000000000000000000000000000000002222',
        'isEvabobUser': true,
        'paidBefore': true,
        'warnings': const [],
        'family': true,
        'avatarUrl': 'https://example.com/mum.jpg',
      });
      expect(c.family, isTrue);
      expect(c.avatarUrl, 'https://example.com/mum.jpg');
    });
  });
}
