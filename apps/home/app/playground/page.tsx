import type {Metadata} from 'next';
import {Playground} from './Playground';

export const metadata:Metadata={
 title:'Layout playground',
 description:'Arrange furniture and save apartment layouts in your browser.',
};

export default function PlaygroundPage(){return <Playground/>;}
