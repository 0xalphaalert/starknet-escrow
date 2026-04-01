import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Menu from './Menu';       
import Kitchen from './Kitchen'; 

export default function App() {
  return (
    <Router>
      <Routes>
        {/* Customer Menu loads on the default URL */}
        <Route path="/" element={<Menu />} />
        
        {/* Kitchen Dashboard loads when you add /kitchen */}
        <Route path="/kitchen" element={<Kitchen />} />
      </Routes>
    </Router>
  );
}