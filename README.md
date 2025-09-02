# 🚇 NYC Subway Real-Time Map

A modern web application displaying live NYC subway train locations using MTA's GTFS-realtime feeds.

## 🚀 Quick Deploy

### Deploy to Vercel (Recommended)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/dantraynor/subwaymap&branch=clean-deployment)

### Deploy to Railway (Alternative)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/dantraynor/subwaymap&branch=clean-deployment)

**Steps for Vercel:**
1. Click the Vercel button above
2. Sign in with GitHub
3. Click "Create" to deploy
4. Wait 2-3 minutes for deployment
5. Your live subway map will be ready at `https://your-project.vercel.app`!

---

## ✨ Features

- 🚇 **Real-time train data** from all MTA subway lines
- 🗺️ **Interactive map** with live train locations  
- 📱 **Responsive design** for mobile and desktop
- 🔄 **Auto-refresh** every 30 seconds
- 🎨 **Color-coded subway lines** matching MTA standards
- ⚡ **No API key required** - uses free MTA feeds
- 🌐 **Custom domain support**

## 🌐 Connect Your Custom Domain

### After Deploying to Vercel:

1. **Get your Vercel URL** (e.g., `your-project.vercel.app`)
2. **In your Spaceship DNS settings**, add:
   ```
   Type: CNAME
   Name: subway
   Value: your-project.vercel.app
   ```
3. **In Vercel dashboard**:
   - Go to your project settings
   - Click "Domains"
   - Add `subway.yourdomain.com`
   - Vercel will verify the DNS automatically

4. **Access your site at**: `subway.yourdomain.com` 🎉

## 🛠️ Local Development

```bash
# Clone and setup
git clone https://github.com/dantraynor/subwaymap.git
cd subwaymap
git checkout clean-deployment

# Install dependencies
npm install

# Start development server
npm run dev

# Open http://localhost:3000
```

## 📊 API Endpoints

- `GET /api/mta/feeds/all` - All real-time train data
- `GET /api/mta/feed/:feedId` - Specific line group data
- `GET /health` - Health check

### Available Feed IDs:
- `1234567` - Lines 1,2,3,4,5,6,7
- `ace` - Lines A,C,E
- `bdfm` - Lines B,D,F,M
- `g` - Line G
- `jz` - Lines J,Z
- `l` - Line L
- `nqrw` - Lines N,Q,R,W
- `si` - Staten Island Railway

## 🏗️ Project Structure

```
subwaymap/
├── server.js              # Express server with API
├── package.json           # Dependencies
├── vercel.json            # Vercel configuration
├── public/
│   ├── index.html         # Main webpage
│   ├── style.css          # Styling
│   └── app.js             # Frontend logic
└── README.md              # This file
```

## 🔧 Technologies Used

- **Backend**: Node.js, Express.js
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Map**: Leaflet.js
- **Data**: MTA GTFS-realtime feeds
- **Deployment**: Vercel, Railway

## 📈 Performance

- **Fast loading**: ≈ 2-3 seconds initial load
- **Real-time updates**: 30-second refresh cycle
- **Mobile optimized**: Works on all devices
- **Serverless**: Scales automatically with traffic

## 🐛 Troubleshooting

### Common Issues:

1. **Build fails**: Check Node.js version (requires 16+)
2. **No train data**: MTA feeds may be temporarily down
3. **CORS errors**: Server includes proper CORS headers
4. **Map not loading**: Check internet connection

### Debug Steps:

1. Open browser developer tools (F12)
2. Check Console for errors
3. Verify `/api/mta/feeds/all` returns data
4. Check Network tab for failed requests

## 📚 Data Sources

- **Real-time**: [MTA GTFS-realtime feeds](https://api.mta.info/#/subwayRealTimeFeeds)
- **Static**: [MTA GTFS static data](https://new.mta.info/developers)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

MIT License - feel free to use this project!

---

**Built with ❤️ for NYC transit enthusiasts**

*Real-time data provided by the MTA*