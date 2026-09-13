# Evabob Mobile

Flutter app for Android Studio testing (beige + emerald glass).

## Open in Android Studio (recommended)

```powershell
cd C:\Users\victoren\Desktop\Projects\evabob\mobile
.\open_in_android_studio.ps1
```

Then: start an emulator → **Run ▶**

Full guide: [ANDROID_STUDIO.md](./ANDROID_STUDIO.md)

## CLI

```powershell
$env:PATH = "C:\Users\victoren\develop\flutter\bin;$env:PATH"
cd C:\Users\victoren\Desktop\Projects\evabob\mobile
flutter pub get
flutter run
```

### Windows desktop

Requires **Developer Mode** (Settings → System → For developers). Then:

```powershell
flutter run -d windows
```

Or use **Chrome**: `flutter run -d chrome`

**Auto demo login** is ON by default (lands on Home immediately).
## Quick test path

1. Home balance in ₦  
2. Chat → Adaobi → `@. send 3500 naira with description food`  
3. Exchange → EUR ↔ USDC  
4. Send (center button) → keypad arithmetic `120+35`  
