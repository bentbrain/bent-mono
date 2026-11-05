"use client";

import { useState } from "react";
import { Button } from "./ui/button";

function HomeButton() {
  const suffixes = [
    "build",
    "brain",
    "clothes",
    "store",
    "art",
    "shoes",
    "dev",
  ];

  const [suffixIndex, setSuffixIndex] = useState(0);

  const handleScramble = () => {
    const newIndex = (suffixIndex + 1) % suffixes.length;
    setSuffixIndex(newIndex);
  };

  return (
    <Button onMouseDown={handleScramble}>bent.{suffixes[suffixIndex]}</Button>
  );
}

export default HomeButton;
