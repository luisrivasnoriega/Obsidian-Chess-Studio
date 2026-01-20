import type { Color, Piece } from "@lichess-org/chessground/types";
import type { Square } from "chessops";
import { squareFromCoords } from "chessops/util";
import { useRef, useState } from "react";
import Draggable from "react-draggable";

export default function PieceComponent({
  piece,
  boardRef,
  putPiece,
  size,
  orientation,
  selectedPiece,
  onSelect,
}: {
  piece: Piece;
  boardRef?: React.RefObject<HTMLDivElement>;
  putPiece?: (square: Square, piece: Piece) => void;
  size?: number | string;
  orientation?: Color;
  selectedPiece?: Piece | null;
  onSelect?: (piece: Piece, isDragging: boolean) => void;
}) {
  size = size || "100%";
  // Use HTMLDivElement for Draggable compatibility, but render as button for accessibility
  const pieceRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);

  const handleClick = () => {
    onSelect?.(piece, hasDragged);
    setHasDragged(false);
  };

  if (!boardRef || !putPiece) {
    return (
      <div
        ref={pieceRef}
        className={getPieceName(piece)}
        style={{
          width: size,
          height: size,
          backgroundSize: "cover",
        }}
      >
        {/* Empty content - piece is rendered via background image */}
      </div>
    );
  }

  const handleDrop = (position: { x: number; y: number }) => {
    const boardRect = boardRef?.current?.getBoundingClientRect();
    if (
      boardRect &&
      position.x > boardRect.left &&
      position.x < boardRect.right &&
      position.y > boardRect.top &&
      position.y < boardRect.bottom
    ) {
      const boardWidth = boardRect.width;
      const boardHeight = boardRect.height;
      const squareWidth = boardWidth / 8;
      const squareHeight = boardHeight / 8;
      let x = Math.floor((position.x - boardRect.left) / squareWidth);
      let y = Math.floor((position.y - boardRect.top) / squareHeight);

      if (orientation === "black") {
        x = 7 - x;
        y = 7 - y;
      }
      const square = squareFromCoords(x, 7 - y);
      if (square) {
        putPiece(square, piece);
      }
    }
  };

  return (
    <Draggable
      nodeRef={pieceRef}
      position={{ x: 0, y: 0 }}
      onDrag={() => {
        setIsDragging(true);
        setHasDragged(true);
      }}
      onStop={(e) => {
        const { clientX, clientY } = e as MouseEvent;
        handleDrop({ x: clientX, y: clientY });
        setIsDragging(false);
      }}
      scale={1}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: Draggable requires HTMLDivElement, but we add role="button" for accessibility */}
      <div
        ref={pieceRef}
        role="button"
        tabIndex={0}
        className={getPieceName(piece)}
        style={{
          backgroundSize: "contain",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
          zIndex: 100,
          backgroundColor:
            !isDragging && selectedPiece && piece.role === selectedPiece.role && piece.color === selectedPiece.color
              ? "var(--mantine-primary-color-filled)"
              : "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
      />
    </Draggable>
  );
}

const getPieceName = (piece: Piece) => `${piece.color} ${piece.role}`;
