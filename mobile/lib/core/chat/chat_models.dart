enum ChatMessageKind { text, receipt, system }

class ChatThread {
  const ChatThread({
    required this.id,
    required this.title,
    required this.subtitle,
    this.handle,
    this.unread = 0,
    this.isAgent = false,
  });

  final String id;
  final String title;
  final String subtitle;
  final String? handle;
  final int unread;
  final bool isAgent;
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
