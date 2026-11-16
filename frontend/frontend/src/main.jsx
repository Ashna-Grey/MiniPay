import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/public-sans';
import './styles.css';
import App from './App.jsx';
// No <StrictMode>: its double-mount would fire two refresh calls, and the backend treats a reused refresh token as theft.
createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
