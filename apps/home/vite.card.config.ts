import {defineConfig} from 'vite';
import {locationDefines} from './build/location';
import react from '@vitejs/plugin-react';
export default defineConfig(({mode})=>({plugins:[react()],define:{...locationDefines(mode),'process.env.NODE_ENV':'"production"'},publicDir:false,build:{outDir:'dist-card',emptyOutDir:true,lib:{entry:'app/HomeAssistantCard.tsx',formats:['es'],fileName:()=> 'apartment-hotel-card.js'},cssCodeSplit:false,rollupOptions:{output:{inlineDynamicImports:true}}}}));
