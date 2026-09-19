enum ChatMessageKind { text, receipt, system }

class ChatThread {
  const ChatThread({
    required this.id,
    required this.title,
    required this.subtitle,
    this.handle,
    this.unread = 0,
    this.isAgent = false,
    this.peerUserId,
    this.peerAvatarUrl,
    this.peerAvatarBundle,
  });

  final String id;
  final String title;
  final String subtitle;
  final String? handle;
  final int unread;
  final bool isAgent;

  /// The other person, and the picture they chose: an uploaded photo (a
  /// server path) or one of the built-in pictures (its index).
  final String? peerUserId;
  final String? peerAvatarUrl;
  final int? peerAvatarBundle;

  ChatThread copyWith({String? subtitle, int? unread}) => ChatThread(
        id: id,
        title: title,
        subtitle: subtitle ?? this.subtitle,
        handle: handle,
        unread: unread ?? this.unread,
        isAgent: isAgent,
        peerUserId: peerUserId,
        peerAvatarUrl: peerAvatarUrl,
        peerAvatarBundle: peerAvatarBundle,
      );

  factory ChatThread.fromJson(Map<String, dynamic> j, {String? fallbackTitle}) =>
      ChatThread(
        id: j['id']?.toString() ?? '',
        title: j['title']?.toString() ?? fallbackTitle ?? '',
        subtitle: j['subtitle']?.toString() ?? '',
        handle: j['handle']?.toString(),
        isAgent: j['isAgent'] == true ||
            j['kind']?.toString() == 'agent' ||
            j['handle']?.toString() == 'evabob' ||
            j['handle']?.toString() == 'sendit',
        peerUserId: j['peerUserId']?.toString(),
        peerAvatarUrl: j['peerAvatarUrl']?.toString(),
        peerAvatarBundle: (j['peerAvatarBundle'] as num?)?.toInt(),
      );
}

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.threadId,
    required this.senderId,
    required this.kind,
    required this.createdAt,
    this.text,
    this.receipt,
    this.meta,
  });

  final String id;
  final String threadId;
  final String senderId;
  final ChatMessageKind kind;
  final DateTime createdAt;
  final String? text;
  final ReceiptData? receipt;
  final Map<String, dynamic>? meta;
}

class ReceiptData {
  const ReceiptData({
    required this.amountLabel,
    required this.fxLabel,
    required this.description,
    required this.statusLabel,
    this.peerName,
    this.sender,
    this.receiver,
    this.hash,
    this.dateLabel,
  });

  final String amountLabel;
  final String fxLabel;
  final String description;
  final String statusLabel;
  final String? peerName;
  final String? sender;
  final String? receiver;
  final String? hash;
  final String? dateLabel;
}
