<p align="center">
  <img src="./brand/rish-readme-icon.svg" alt="Rish" width="96" />
</p>

<h1 align="center">Rish, cebinizdeki ajanınız.</h1>

<p align="center">
  <strong>Yerel olarak çalıştırın. Modelinizi seçin.</strong><br />
  <sub>Yerel çalışma alanları · Model seçimi · Araç yürütme · Onaylar</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>Yerleşik bağlantılar · Rish'e özgü adaptörler</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <b>Türkçe</b> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#başlayın">Başlayın</a> ·
  <a href="#yerleşik-bağlantılar">Yerleşik bağlantılar</a> ·
  <a href="#ürün-turu">Ürün turu</a> ·
  <a href="#platformlar-ve-modeller">Platformlar ve modeller</a> ·
  <a href="#ekosistem">Ekosistem</a> ·
  <a href="./docs/development.md">Geliştirici kılavuzu</a> ·
  <a href="./LICENSE">MIT Lisansı</a>
</p>

<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — cebinizdeki ajanınız. Yerel yürütme. Model özgürlüğü. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

Rish, Ajan sohbetlerini, çalışma alanlarını ve araç yürütmesini telefonunuza getirir.
Bir model seçin, bir görev tanımlayın, yapılan işi inceleyin ve bir bilgisayarı çalışır
durumda tutmadan değişiklikleri onaylayın. Kod yazmak kullanım alanlarından biridir;
tek amacı değildir.

> **Deneysel bir kaynak önizlemesi hazırlanıyor; henüz yüklenebilir kararlı bir sürüm
> yok.** Platform kapsamı ile hesap/abonelik doğrulama durumu
> [Platformlar ve modeller](#platformlar-ve-modeller) bölümünde özetlenmektedir.

## Yerleşik bağlantılar

**Dört yerleşik bağlantı. Tek cep çalışma alanı.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · Düzenlenebilir model kataloğu</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · API anahtarı / Abonelik girişi¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · API anahtarı / Abonelik girişi¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · API anahtarı / Abonelik girişi¹</sub>
</td>
</tr>
</table>

¹ Abonelik girişi şu anda yalnızca iOS'ta mevcut. BigModel Coding Lite doğrulanmıştır; Codex ve Claude Code isteğe bağlı deneysel yapıyı gerektirir. Doğrulama ayrıntıları için aşağıya bakın.

Bir harness seçin ve API anahtarı ya da kullandığınız yapının desteklediği bir hesapla
bağlanın. Ardından telefonunuzdaki dosyalar ve projeler üzerinde çalışmaya başlayın.
Rish; ajan döngüsünü, çalışma alanını, araç onaylarını ve yürütme kayıtlarını yönetir;
yerleşik adaptörler model hizmetlerine bağlanır.

**Hesap ve abonelik doğrulaması (iOS)**

- **Codex**: İsteğe bağlı deneysel yapı; resmi CLI cihaz girişini, abonelikle yapılan bir `gpt-5.6-luna` metin sohbetini, yerel bir `list_dir` araç çağrısını ve yeniden başlatma sonrası kalıcılığı doğruladı. Resmi CLI yalnızca giriş için kullanılır; tüm araçlar ve modeller doğrulanmış değildir.
- **GLM**: [ZCode](https://zcode.z.ai/en/docs/agents), Zhipu'nun ajan ürünüdür; GLM ise model ailesidir. BigModel girişi, yeniden başlatma sonrası kalıcılık ve bir Coding Lite GLM-5.3 yanıtı doğrulandı; deneme kotası doğrulanmadı. Resmi ZCode çalışma zamanı entegre edilmedi.
- **Claude Code**: İsteğe bağlı iOS deneysel yapı; abonelik girişini, değiştirilmemiş resmi CLI üzerinden alınan bir Haiku 4.5 metin yanıtını ve yeniden başlatma sonrası kalıcılığı doğruladı. Bu yol şu anda yalnızca metni destekler; araç veya ek desteği yoktur. Ölçülen bir tur yaklaşık 4,5 dakika sürdü; performansın hâlâ geliştirilmesi gerekiyor.

## Ürün turu

Ajan yürütmesini izleyin, proje değişikliklerini inceleyin ve bir model bağlantısı seçin.
Orijinalini açmak için ekran görüntülerinden birine tıklayın.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="iPhone'da iki başarılı araç çağrısını ve mutlak bir yolun reddedildiğini açıklayan bir özeti gösteren Rish" width="280" /></a><br />
  <sub><b>Ajan sohbeti</b> — İlerlemeyi, araç çağrılarını ve sonuçları telefonda izleyin. Çalışma alanı dışındaki bir yol reddedilir ve model bir sonraki turda kendini düzeltir.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Staging'e eklenmemiş dosyaları ve değişiklik istatistiklerini gösteren Rish iOS Simulator" width="280" /></a><br />
  <sub><b>Yerel projeler</b> — Commit etmeden önce staging'e eklenmemiş dosyaları ve değişiklik istatistiklerini inceleyin.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Çalışma alanı kenar çubuğunu ve dört yerel API adaptörü girdisini gösteren Rish iPad Simulator" width="100%" /></a><br />
  <sub><b>iPad çalışma alanı ve model bağlantıları</b> — Geniş ekran kenar çubuğu, koyu görünüm ve API adaptörü girdileri.</sub>
</td>
</tr>
</table>

Tüm ekran görüntüleri gerçek Simulator'lardan alınmıştır; güncel kullanıcı arayüzünü ve iş akışını gösterir.

## Neden Rish

<table>
<tr>
<td width="50%">

### Çalışma alanınız sizinle gelir

Dosyalarınızı ve projelerinizi telefonun uygulamaya ait çalışma alanında tutun. Materyal
içe aktarın, dosyaları okuyun, proje değişikliklerini inceleyin ve tek bir uygulamada
çalışmaya devam edin.

</td>
<td width="50%">

### Modelinizi seçin

Yerleşik DSH, Claude Code, Codex ve GLM girdileriyle başlayın ya da uyumlu bir API
hizmeti ve model eşlemeleri yapılandırın. Sonraki adımı model önerir; işlemi yerel
araçlar gerçekleştirir.

</td>
</tr>
<tr>
<td width="50%">

### İşin ilerleyişini görün

Her turun metnini, isteğe bağlı olarak sağlayıcının döndürdüğü akıl yürütmeyi, araç
çağrılarını ve nihai sonucu izleyin. Bağlantıları doğrudan açın ve kayıtlı sohbetlere
geri dönün.

</td>
<td width="50%">

### Kontrolü elinizde tutun

Araçlar sınırlı bir çalışma alanı içinde çalışır. Yetki gerektiren işlemler önce izin
ister; dosya değişiklikleri ve Git farkları incelemenize açıktır.

</td>
</tr>
</table>

## İşe koyulun

| Görev | Bir başlangıç noktası |
| --- | --- |
| Bilgiyle çalışın | Metin veya bir PDF içe aktarın, ana noktaları isteyin, ardından Ajan'ın kaydettiği notları inceleyin. |
| Dosyaları düzenleyin | Bir proje dizinini inceleyin, seçili dosyaları okuyun ve yeni ya da güncellenmiş içeriği onaylayın. |
| Bir projeyi sürdürün | Git durumunu ve farkları inceleyin, dosyaları düzenleyin ve bir commit'i onaylayın. |

Bu örnekler, şu anda kullanılabilen iOS yeteneklerini kullanır. Desteklenen araçlar ve
dosya biçimleri platforma göre değişir. Linux Guest deneyleri için
[çalışma zamanı başvurusuna](docs/development.md#honest-runtime-boundary) bakın.

## Yerel yürütme nasıl çalışır

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

Desteklenen araçlar telefonun uygulamaya ait ortamında yürütülür. Model istekleri,
seçili sohbet ve görev bağlamını yapılandırdığınız hizmete gönderir:
**yerel yürütme, çevrimdışı model çıkarımı anlamına gelmez**.

Rish; yerel dosya/Git işlemlerini, Rish çalışma zamanını ve deneysel bir Linux Guest'i
bir araya getirir. Tam masaüstü programı uyumluluğu ve süresiz arka plan yürütmesi
vaat edilmiyor. [Geliştirici kılavuzu](docs/development.md), doğrulanmış yetenekleri
deneysel yollardan ayırır.

## Platformlar ve modeller

| Platform | Mevcut kapsam |
| --- | --- |
| iOS / iPadOS | Yerel sohbetler, ekler, Dosyalar, Git ve kontrollü Ajan araçları; uyarlanabilir iPad düzenleri dahil. |
| Android | Yerel API sohbeti, kimlik bilgisi depolama, oturum kurtarma ve kapsamlandırılmış görev bildirimleri. Yerel Ajan, Dosyalar ve Git yürütmesi henüz kullanılamıyor. |
| HarmonyOS | Geçici Android uyumluluk konteyneri denetimleri, yerel HarmonyOS desteği oluşturmaz. |

| Bağlantı | Mevcut yöntem |
| --- | --- |
| DeepSeek / DSH | API anahtarı ve düzenlenebilir model kataloğu; yetenekler modele ve platforma bağlıdır. |
| GLM | API anahtarı ve isteğe bağlı BigModel/Z.ai hesap bağlantısı; yukarıdaki duruma bakın. |
| Codex | API adaptörü; isteğe bağlı deneysel iOS yapısı abonelik girişi ekler — yukarıdaki duruma bakın. |
| Claude Code | Uyumlu hizmet yapılandırmasıyla API adaptörü; abonelik metin çağrıları, yukarıda belirtilen kapsam ve gecikmeyle isteğe bağlı iOS yapısında doğrulanmıştır. |
| Özel hizmetler | iOS'ta Messages, Responses veya Chat Completions seçin ve model eşlemelerini yapılandırın. |

## Ekosistem

Rish, **[ZSeven-W](https://github.com/ZSeven-W)**'nin yerel-öncelikli, yapay zekâ odaklı araçlar ailesinin bir parçasıdır. `rish` bu uygulamanın içindeki Linux Guest'i önyükler; diğerleri de aynı fikri başka yüzeylere — terminale, tasarım tuvaline ve bir ajanın belleğine — taşır.

| Proje | Ne olduğu |
| ------- | ---------- |
| **[rish](https://github.com/ZSeven-W/rish)** | Telefonda gerçek Docker: iOS ve Android'de Linux'u önyükleyip konteynerler çalıştıran, saf Rust ile yazılmış, JIT'siz x86-64 tam sistem yorumlayıcısı. Bu uygulamanın Linux Guest'i buradan geliyor. |
| <img src="./docs/images/ecosystem/openpencil.png" alt="OpenPencil" width="40" /> **[OpenPencil](https://github.com/ZSeven-W/openpencil)** | İlk açık kaynaklı, yapay zekâ odaklı vektör tasarım aracı ve eşzamanlı Agent Teams sunan ilk araç. Design-as-Code — istemleri doğrudan canlı tuvalde arayüze dönüştürün. |
| <img src="./docs/images/ecosystem/jian.png" alt="jian" width="40" /> **[jian](https://github.com/ZSeven-W/jian)** | Saf Rust ile yazılmış, GPU-Skia arayüz çerçevesi. Bildirimsel bir `.op` belgesini yerel bir uygulamaya dönüştürür — JS çalışma zamanı yok, DOM yok, Electron yok. |
| <img src="./docs/images/ecosystem/zode.png" alt="Zode" width="40" /> **[Zode](https://github.com/ZSeven-W/zode)** | Terminaliniz için yapay zekâ odaklı kodlama CLI'sı. Kodunuzu okuyan, komutlar çalıştıran, dosyalarda arama yapan ve git'i yöneten hızlı bir Rust TUI. |
| <img src="./docs/images/ecosystem/noema.png" alt="noema" width="40" /> **[noema](https://github.com/ZSeven-W/noema)** | Kodlama ajanları için yerel-öncelikli, vektör tabanlı olmayan bellek. Kalıcı bellek; incelenebilir dosyalar, bir inceleme kuyruğu ve embedding gerektirmeyen geri çağırmadan oluşur. |

## Başlayın

Şimdilik kaynaktan derleyin; kararlı bir son kullanıcı indirmesi yok. Kaynağı elde
ettikten sonra depo kök dizininden başlayın:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** Yerel hazırlık, sabitlenmiş Xcode, Rust ve SDK sürümleri gerektirir.
[Ön koşulları](docs/development.md#ios-build-prerequisites) okuyun, ardından şunları
çalıştırın:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** Yapılandırılmış bir Android geliştirme ortamıyla
`npm run android --prefix apps/mobile` komutunu çalıştırın. Geliştirici kılavuzu
[bağımsız test APK'larını](docs/development.md#install-and-run-the-react-native-app)
da kapsar.

Uygulamayı açın, bir model seçin ve bir API anahtarı veya desteklenen bir hesapla
bağlanın. iOS'ta bir proje oluşturun veya seçin, bağlamını inceleyin ve bir görev
başlatın. Codex ve Claude Code abonelik girişi isteğe bağlı deneysel bir yapı
gerektirir ([geliştirici kılavuzuna](docs/development.md) bakın); BigModel için
[hesap kılavuzuna](docs/zcode-account-login.md) bakın. Kimlik bilgileri yerel güvenli
depolamada kalır.

## İlerleme ve katkıda bulunma

İlk kaynak önizlemesi hazırlanıyor. Gelecekteki sürümler **Pre-release** olarak
işaretlenecek. Eksiksiz Harness uyumluluğu, Android'de yerel yürütme ve sürekli arka
plan işlemi sınırlı olmaya devam ediyor. [Önizleme kapsamına ve yol
haritasına](docs/releases/v0.1.0.md) bakın.

Dokümantasyon, platform desteği, model uyumluluğu ve yeniden üretilebilir düzeltmelere
katkılar memnuniyetle karşılanır. Önce [CONTRIBUTING](CONTRIBUTING.md) dosyasını
okuyun. Güvenlik sorunlarında ayrıntıları paylaşmadan önce
[SECURITY](SECURITY.md) dosyasına danışın; kimlik bilgilerini veya hassas verileri
asla herkese açık şekilde paylaşmayın.

- [Geliştirici ve derleme kılavuzu](docs/development.md)
- [Marka ve onaylı metinler](brand/README.md)
- [Üçüncü taraf bildirimleri ve Guest kaynakları](THIRD_PARTY_NOTICES.md)

Proje kodu [MIT](LICENSE) lisansı altında sunulur. Üçüncü taraf çalışma zamanları,
Guest bileşenleri ve diğer bağımlılıklar kendi lisanslarını korur.
