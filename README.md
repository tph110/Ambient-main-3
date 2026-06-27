# EchoDoc - AI Medical Scribe for Healthcare Professionals

> **Save 30 minutes per clinic with intelligent medical transcription**

EchoDoc is a privacy-focused AI medical scribe application designed specifically for UK healthcare professionals. It transforms clinical consultations into structured documentation using advanced speech recognition and AI summarization.

---

## 🎯 Features

### Clinical Scribe (index.html)
- **🎙️ High-Quality Audio Recording** - Compressed audio (12kbps) for efficient long recordings
- **🎯 AI-Powered Transcription** - Deepgram's medical-grade transcription API with British English support
- **🏥 Clinical Summary Generation** - Structured clinical notes in NHS-appropriate format
- **📄 Referral Letter Generation** - Professional secondary care referral letters
- **👤 Patient Summary Generation** - Plain-English summaries for patient communication
- **🔒 Patient Data Anonymization** - Automatically removes names, addresses, NHS numbers, and identifying information
- **📞 Telephone Consultation Mode** - Captures both microphone and phone call audio
- **🎤 Microphone Selection** - Choose from available audio input devices
- **📊 Real-Time Recording Monitoring** - Live audio visualization and file size tracking
- **⏱️ Recording Timer & Limits** - Prevents data loss with 4MB limit warnings
- **🌙 Dark Mode** - Eye-friendly dark theme with preference saving
- **✏️ Editable Outputs** - All generated text is editable before copying
- **📋 One-Click Copy** - Copy any output directly to clipboard

### AI Dictation (dictation.html)
- **🎤 Voice-to-Text Dictation** - Continuous dictation for letters and documents
- **🤖 AI Formatting** - Intelligent formatting and structuring of dictated content
- **📝 Multiple Output Formats** - Support for various document types
- **🌙 Dark Mode** - Consistent dark theme across both tools

---

## 🚀 Live Demo

Visit the live application: **[https://ambientdoc.vercel.app](https://ambientdoc.vercel.app)**

---

## 🏗️ Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Frontend** | HTML5, CSS3, JavaScript | Modern responsive UI |
| **Styling** | Custom CSS with CSS Grid | Professional medical interface |
| **Animations** | Anime.js | Smooth UI transitions |
| **Transcription API** | Deepgram (nova-2-medical) | Medical-grade speech-to-text |
| **AI Summarization** | OpenRouter (Claude Sonnet 4) | Clinical document generation |
| **Hosting** | Vercel | Serverless deployment |
| **Audio Processing** | MediaRecorder API | Browser-native recording |

---

## 📋 Prerequisites

Before deploying EchoDoc, you'll need:

1. **GitHub Account** - For version control
2. **Vercel Account** - For hosting (free tier works)
3. **Deepgram API Key** - For transcription ([Get one here](https://deepgram.com))
4. **OpenRouter API Key** - For AI summaries ([Get one here](https://openrouter.ai))

---

## 🔧 Setup Instructions

### Step 1: Clone or Fork the Repository

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/echodoc.git
cd echodoc

# Or fork it on GitHub and clone your fork
```

### Step 2: Get Your API Keys

#### Deepgram API Key (Transcription)
1. Go to [Deepgram Console](https://console.deepgram.com)
2. Sign up for a free account (includes $200 free credit)
3. Navigate to "API Keys" section
4. Create a new API key and copy it

#### OpenRouter API Key (AI Summarization)
1. Go to [OpenRouter](https://openrouter.ai)
2. Sign up or log in
3. Navigate to "Keys" section
4. Create a new API key and copy it

### Step 3: Deploy to Vercel

#### Option A: One-Click Deploy (Easiest)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/echodoc)

#### Option B: Manual Deploy

1. Go to [Vercel](https://vercel.com)
2. Sign in with GitHub
3. Click "Add New Project"
4. Import your GitHub repository
5. Vercel auto-detects settings (no configuration needed)
6. Click "Deploy"

### Step 4: Configure Environment Variables

After deployment:

1. Go to your Vercel project dashboard
2. Click **Settings** → **Environment Variables**
3. Add these two variables:

| Name | Value | Environment |
|------|-------|-------------|
| `DEEPGRAM_API_KEY` | Your Deepgram API key | Production, Preview, Development |
| `OPENROUTER_API_KEY` | Your OpenRouter API key | Production, Preview, Development |

4. Click **Save**
5. Go to **Deployments** → Click **Redeploy** on latest deployment

### Step 5: Test Your Deployment

1. Visit your Vercel URL (e.g., `your-app.vercel.app`)
2. Allow microphone access when prompted
3. Click "Start Recording"
4. Speak for a few seconds
5. Click "Finish"
6. Wait for transcription
7. Click "Generate Clinical Documents"
8. Verify all features work correctly ✅

---

## 💻 Local Development

To run EchoDoc locally:

### 1. Install Vercel CLI

```bash
npm install -g vercel
```

### 2. Clone and Setup

```bash
git clone https://github.com/YOUR_USERNAME/echodoc.git
cd echodoc
```

### 3. Create Local Environment Variables

Create a `.env` file in the root directory:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

### 4. Run Development Server

```bash
vercel dev
```

The app will be available at `http://localhost:3000`

---

## 📁 Project Structure

```
echodoc/
├── index.html              # Clinical Scribe page
├── dictation.html          # AI Dictation page
├── app.js                  # Clinical Scribe JavaScript
├── dictation.js            # AI Dictation JavaScript
├── styles.css              # Main stylesheet
├── api/
│   ├── transcribe.js       # Deepgram transcription endpoint
│   └── summarize.js        # OpenRouter summarization endpoint
├── vercel.json             # Vercel configuration
└── README.md               # This file
```

---

## 🎯 How It Works

### Recording Flow

1. **Audio Capture** - MediaRecorder API captures microphone audio at 12kbps
2. **Compression** - Opus codec compresses audio for efficient storage
3. **Size Monitoring** - Real-time tracking prevents recordings exceeding 4MB
4. **Telephone Mode** (Optional) - Mixes microphone + system audio via screen share

### Transcription Flow

1. **Audio Upload** - Compressed WebM audio sent to `/api/transcribe`
2. **Deepgram Processing** - Deepgram's `nova-2-medical` model transcribes with British English
3. **Display** - Full transcript displayed in editable text box

### Summarization Flow

1. **Anonymization** (Optional) - Removes patient names, addresses, NHS numbers, phone numbers
2. **API Request** - Anonymized transcript sent to `/api/summarize`
3. **Claude Processing** - Claude Sonnet 4 generates structured clinical summary
4. **Multiple Outputs** - Generate referral letters and patient summaries from clinical summary

---

## 🔒 Privacy & Security

EchoDoc is designed with healthcare data protection in mind:

### ✅ Privacy Features

- **Client-Side Processing** - Audio recorded and compressed in browser
- **No Audio Storage** - Audio transcribed and immediately discarded
- **Anonymization** - Optional removal of identifying information before AI processing
- **HTTPS Required** - All communication encrypted (provided by Vercel)
- **No Session Storage** - No conversation data stored on servers
- **Local Storage Only** - Dark mode preferences stored locally

### ⚠️ Important Disclaimers

> **This is a demonstration tool for educational and development purposes.**

For production clinical use:
- ✅ Obtain appropriate patient consent
- ✅ Ensure GDPR and NHS data protection compliance
- ✅ Follow your organization's information governance policies
- ✅ Verify all AI-generated content before adding to patient records
- ✅ Maintain clinician responsibility for all documentation

---

## 🌍 Browser Compatibility

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome | ✅ Fully Supported | Recommended for best experience |
| Edge | ✅ Fully Supported | Chromium-based, works perfectly |
| Safari | ⚠️ Partial Support | May have audio compression issues |
| Firefox | ✅ Fully Supported | Requires user permission for microphone |
| Mobile Chrome | ✅ Supported | Responsive design optimized |
| Mobile Safari | ⚠️ Partial Support | Audio recording may be limited |

**Requirements:**
- HTTPS connection (provided by Vercel)
- Microphone access permission
- Modern browser with MediaRecorder API support

---

## 💰 Cost Breakdown

### Vercel (Hosting)
- **Free Tier**: 100GB bandwidth/month, 100GB-hrs compute
- **Pro Tier**: $20/month (if needed for higher usage)

### Deepgram (Transcription)
- **Free Credit**: $200 free credit on signup
- **Pay-As-You-Go**: $0.0043/minute (nova-2-medical model)
- **Example**: 100 x 10-minute consultations = ~$4.30

### OpenRouter (AI Summarization)
- **Claude Sonnet 4**: ~$3 per million input tokens
- **Example**: 100 summaries (500 words each) = ~$0.15

**Total Monthly Cost (100 consultations)**: ~$4.45 + hosting

---

## 🎨 Customization

### Change AI Model

In `api/summarize.js`, modify:

```javascript
model: 'anthropic/claude-sonnet-4-20250514'
```

Available alternatives:
- `anthropic/claude-opus-4-20250514` (Most capable, higher cost)
- `openai/gpt-4-turbo`
- `openai/gpt-4o`

### Change Transcription Language

In `api/transcribe.js`, modify:

```javascript
language: 'en-GB'  // British English
```

Available options:
- `en-US` - American English
- `en-AU` - Australian English
- `es` - Spanish
- `fr` - French
- `de` - German

### Modify Clinical Summary Format

In `api/summarize.js`, update the system prompt to customize output format.

---

## 🐛 Troubleshooting

### Issue: Microphone Not Working
**Solutions:**
- ✅ Grant microphone permissions in browser settings
- ✅ Ensure HTTPS connection (required for microphone access)
- ✅ Check if another app is using the microphone
- ✅ Try a different browser (Chrome recommended)

### Issue: Transcription Fails
**Solutions:**
- ✅ Verify `DEEPGRAM_API_KEY` is set correctly in Vercel
- ✅ Check Deepgram account has remaining credits
- ✅ Ensure recording is under 4MB (approximately 40 minutes at 12kbps)
- ✅ Check browser console for error messages

### Issue: Summary Generation Fails
**Solutions:**
- ✅ Verify `OPENROUTER_API_KEY` is set correctly in Vercel
- ✅ Check OpenRouter account has credits
- ✅ Ensure transcript is not empty
- ✅ Check browser console for API errors

### Issue: Recording Stuck at "Loading microphones..."
**Solutions:**
- ✅ Hard refresh page (Ctrl+Shift+R)
- ✅ Check for JavaScript syntax errors in console
- ✅ Verify all files deployed correctly to Vercel
- ✅ Clear browser cache

### Issue: Dark Mode Not Working
**Solutions:**
- ✅ Verify dark mode CSS is in `styles.css`
- ✅ Check dark mode JavaScript is in `app.js`
- ✅ Clear browser localStorage and refresh
- ✅ Try toggling the dark mode switch multiple times

---

## 🔄 Deployment & Updates

### Automatic Deployment
Every push to `main` branch automatically deploys to Vercel:

```bash
git add .
git commit -m "Your update message"
git push origin main
```

### Manual Deployment
Use Vercel CLI:

```bash
vercel --prod
```

### Rollback Deployment
In Vercel dashboard:
1. Go to **Deployments**
2. Find a previous successful deployment
3. Click **⋯** → **Promote to Production**

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- **Deepgram** - Medical-grade transcription API
- **Anthropic** - Claude AI for clinical summarization
- **OpenRouter** - Unified AI API access
- **Vercel** - Serverless hosting platform
- **NHS** - Inspiration for clinical documentation standards

---

## 📞 Support & Contact

- **Issues**: [GitHub Issues](https://github.com/YOUR_USERNAME/echodoc/issues)
- **Discussions**: [GitHub Discussions](https://github.com/YOUR_USERNAME/echodoc/discussions)
- **Email**: your.email@example.com

---

## ⚡ Future Roadmap

- [ ] Multiple speaker identification
- [ ] Integration with NHS SystmOne/EMIS
- [ ] PDF export for clinical summaries
- [ ] Voice commands for hands-free operation
- [ ] Multi-language support
- [ ] Consultation templates for common scenarios
- [ ] Integration with clinical coding systems (SNOMED CT)
- [ ] Real-time collaborative note-taking
- [ ] Mobile app (iOS/Android)

---

## 📊 Project Status

**Current Version**: 1.0.0  
**Status**: Active Development  
**Last Updated**: January 2025

---

<div align="center">

**Built with ❤️ for UK Healthcare Professionals**

Made by [Your Name] | [GitHub](https://github.com/YOUR_USERNAME) | [Website](https://your-website.com)

</div>
