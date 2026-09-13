import { useMemo } from 'react';
import { Candle, TradeSignal } from '../types';

interface MiniChartProps {
  candles: Candle[];
  signal?: TradeSignal | null;
  currentPrice: number;
}

export const MiniChart = ({ candles, signal, currentPrice }: MiniChartProps) => {
  const chartData = useMemo(() => {
    if (!candles || candles.length === 0) return null;
    const slice = candles.slice(-25); // display last 25 candles
    let min = Math.min(...slice.map((c) => c.low));
    let max = Math.max(...slice.map((c) => c.high));

    if (signal && signal.signal !== 'NO TRADE') {
      min = Math.min(min, signal.stopLoss, signal.tp1, signal.tp2);
      max = Math.max(max, signal.stopLoss, signal.tp1, signal.tp2);
    }

    // Add 10% padding top and bottom
    const range = max - min || 1;
    const chartMin = min - range * 0.05;
    const chartMax = max + range * 0.05;
    const chartRange = chartMax - chartMin;

    return {
      candles: slice,
      chartMin,
      chartMax,
      chartRange,
    };
  }, [candles, signal]);

  if (!chartData) {
    return (
      <div className="h-36 flex items-center justify-center bg-stone-950/40 rounded-xl text-stone-600 text-xs">
        جارٍ جلب شموع السوق...
      </div>
    );
  }

  const { candles: slice, chartMin, chartRange } = chartData;
  const width = 600;
  const height = 180;
  const candleWidth = width / slice.length;

  const getY = (val: number) => {
    return height - ((val - chartMin) / chartRange) * height;
  };

  return (
    <div className="bg-stone-950/80 border border-stone-800/80 rounded-xl p-2.5 overflow-hidden">
      <div className="flex items-center justify-between text-[10px] text-stone-400 mb-1 px-1">
        <span>5M Candles Structure & Zones</span>
        <span className="font-mono text-stone-300">Live: ${currentPrice.toFixed(2)}</span>
      </div>

      <div className="relative w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-36 select-none font-mono text-[9px]">
          {/* Subtle horizontal grid lines */}
          <line x1="0" y1={height * 0.25} x2={width} y2={height * 0.25} stroke="#292524" strokeDasharray="3 3" />
          <line x1="0" y1={height * 0.5} x2={width} y2={height * 0.5} stroke="#292524" strokeDasharray="3 3" />
          <line x1="0" y1={height * 0.75} x2={width} y2={height * 0.75} stroke="#292524" strokeDasharray="3 3" />

          {/* Candlesticks */}
          {slice.map((c, i) => {
            const x = i * candleWidth + candleWidth / 2;
            const yHigh = getY(c.high);
            const yLow = getY(c.low);
            const yOpen = getY(c.open);
            const yClose = getY(c.close);

            const isGreen = c.close >= c.open;
            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
            const barWidth = Math.max(3, candleWidth * 0.65);

            return (
              <g key={c.timestamp || i}>
                {/* Wick */}
                <line
                  x1={x}
                  y1={yHigh}
                  x2={x}
                  y2={yLow}
                  stroke={isGreen ? '#10b981' : '#f43f5e'}
                  strokeWidth="1.2"
                />
                {/* Body */}
                <rect
                  x={x - barWidth / 2}
                  y={bodyTop}
                  width={barWidth}
                  height={bodyHeight}
                  fill={isGreen ? '#10b981' : '#f43f5e'}
                  rx="1"
                />
              </g>
            );
          })}

          {/* Current Price Line */}
          <line
            x1="0"
            y1={getY(currentPrice)}
            x2={width}
            y2={getY(currentPrice)}
            stroke="#f59e0b"
            strokeWidth="1.2"
            strokeDasharray="4 2"
          />

          {/* Trade Signal Overlay lines if active signal */}
          {signal && signal.signal !== 'NO TRADE' && (
            <>
              {/* Entry line */}
              <line
                x1="0"
                y1={getY(signal.entry)}
                x2={width}
                y2={getY(signal.entry)}
                stroke="#38bdf8"
                strokeWidth="1.5"
              />
              <text x={width - 55} y={getY(signal.entry) - 3} fill="#38bdf8" fontWeight="bold">
                Entry {signal.entry}
              </text>

              {/* Stop Loss line */}
              <line
                x1="0"
                y1={getY(signal.stopLoss)}
                x2={width}
                y2={getY(signal.stopLoss)}
                stroke="#f43f5e"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />
              <text x={width - 55} y={getY(signal.stopLoss) - 3} fill="#f43f5e" fontWeight="bold">
                SL {signal.stopLoss}
              </text>

              {/* TP1 line */}
              <line
                x1="0"
                y1={getY(signal.tp1)}
                x2={width}
                y2={getY(signal.tp1)}
                stroke="#10b981"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />
              <text x={width - 55} y={getY(signal.tp1) - 3} fill="#10b981" fontWeight="bold">
                TP1 {signal.tp1}
              </text>
            </>
          )}
        </svg>
      </div>
    </div>
  );
};
