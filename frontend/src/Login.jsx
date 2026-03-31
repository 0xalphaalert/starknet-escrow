import { usePrivy } from '@privy-io/react-auth';
import Menu from './Menu.jsx'; // Add this import

export default function Login() {
  const { ready, authenticated, login } = usePrivy();

  if (!ready) return <div style={{ padding: '20px', textAlign: 'center' }}>Loading Robotic Restaurant...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '50px', fontFamily: 'sans-serif' }}>
      
      {authenticated ? (
        // SHOW THE REAL MENU ONCE LOGGED IN
        <Menu /> 
      ) : (
        // SHOW THE LOGIN BUTTON IF NOT LOGGED IN
        <div style={{ textAlign: 'center' }}>
          <h1>Robotic Restaurant</h1>
          <p style={{ color: 'gray', marginBottom: '20px' }}>Scan successful. Please log in to view the menu.</p>
          <button 
            onClick={login}
            style={{ padding: '15px 30px', fontSize: '18px', backgroundColor: '#4285F4', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
          >
            Continue with Google
          </button>
        </div>
      )}
    </div>
  );
}