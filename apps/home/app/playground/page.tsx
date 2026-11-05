import type {Metadata} from 'next';
import {Playground} from './Playground';

export const metadata:Metadata={
 title:'Layout playground',
 description:'Try apartment floor-plan and furniture layouts in a browser-only workspace.',
};

export default function PlaygroundPage(){return <Playground/>;}
