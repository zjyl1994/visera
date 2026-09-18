import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import App from './App'
import './styles.css'

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#ff795f', contrastText: '#11161d' },
    secondary: { main: '#79c8bd' },
    background: { default: '#11161d', paper: '#19212b' },
    text: { primary: '#f5f1e8', secondary: '#bcc5d0' },
    divider: 'rgba(215, 225, 236, .13)',
    error: { main: '#ff8d84' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h4: { fontSize: 'clamp(1.8rem, 3vw, 2.6rem)', fontWeight: 700, letterSpacing: '-.045em' },
    h6: { fontWeight: 700, letterSpacing: '-.02em' },
    button: { fontWeight: 650, letterSpacing: 0, textTransform: 'none' },
  },
  components: {
    MuiButton: { styleOverrides: { root: { minHeight: 36, borderRadius: 9 }, contained: { boxShadow: 'none' } } },
    MuiIconButton: { styleOverrides: { root: { minWidth: 36, minHeight: 36 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiTextField: { defaultProps: { size: 'small' } },
  },
})
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } } })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><QueryClientProvider client={queryClient}><ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider></QueryClientProvider></BrowserRouter></React.StrictMode>,
)
