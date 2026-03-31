import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { PrivyProvider } from '@privy-io/react-auth'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        loginMethods: ['google', 'email', 'wallet'],
        appearance: {
          theme: 'light',
          accentColor: '#6A0DAD',
        },
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
        }
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>,
)