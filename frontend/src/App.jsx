import Login from './Login.jsx';
import Kitchen from './Kitchen.jsx';
import './App.css'; 

function App() {
  // If the URL ends in /kitchen, show the Restaurant Dashboard
  if (window.location.pathname === '/kitchen') {
    return <Kitchen />;
  }

  // Otherwise, show the normal Customer App
  return (
    <main>
      <Login />
    </main>
  );
}

export default App;