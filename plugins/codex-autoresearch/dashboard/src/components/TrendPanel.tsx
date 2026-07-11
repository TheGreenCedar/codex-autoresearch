import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { buildChart } from "../model";
import type { DashboardReadout, SessionSegment } from "../types";
import { useUrlParam } from "../hooks/useUrlState";
import { ExperimentModal } from "./trend/ExperimentModal";
import { MetricDetails } from "./trend/MetricDetails";
import { ChartControls, StatusLegend, TrendChartFigure } from "./trend/TrendChartFigure";
import { restoreChartPointFocus, type ChartPointOpener } from "./trend/focus";
import {
  AXIS_MODES,
  buildChartData,
  buildTrendChartState,
  chartPointBudget,
  sampleTrendChartData,
  VALUE_MODES,
  type ChartDatum,
  type ValueMode,
  type AxisMode,
} from "./trend/shared";

interface TrendPanelProps {
  session: SessionSegment;
  readout: DashboardReadout;
  detailsDefaultOpen?: boolean;
  chartHeight?: number;
}

export function TrendPanel({
  session,
  readout,
  detailsDefaultOpen = true,
  chartHeight = 350,
}: TrendPanelProps) {
  const [valueModeParam, setValueMode] = useUrlParam("value", VALUE_MODES, "value");
  const [axisModeParam, setAxisMode] = useUrlParam("axis", AXIS_MODES, "iteration");
  const valueMode = valueModeParam as ValueMode;
  const axisMode = axisModeParam as AxisMode;
  const [openedPoint, setOpenedPoint] = useState<ChartDatum | null>(null);
  const [selectedRunNumber, setSelectedRunNumber] = useState<number | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [restoreFocusTick, setRestoreFocusTick] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const modalOpenerRef = useRef<ChartPointOpener>(null);
  const modalOpenerSelectorRef = useRef<string>("");
  const chart = useMemo(() => buildChart(session, readout), [readout, session]);
  const chartData = useMemo(() => buildChartData(chart, readout), [chart, readout]);
  useEffect(() => {
    const latest = chartData.find((point) => point.latest) || chartData.at(-1) || null;
    if (chartData.some((point) => point.runNumber === selectedRunNumber)) return;
    setSelectedRunNumber(latest?.runNumber ?? null);
  }, [chartData, selectedRunNumber]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const updateWidth = () => setChartWidth(panel.clientWidth);
    updateWidth();
    window.addEventListener("resize", updateWidth);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateWidth);
    observer?.observe(panel);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, []);
  const displayedChartData = useMemo(
    () => sampleTrendChartData(chartData, chartPointBudget(chartWidth), selectedRunNumber),
    [chartData, chartWidth, selectedRunNumber],
  );
  const chartState = useMemo(
    () =>
      buildTrendChartState({
        axisMode,
        chart,
        chartData: displayedChartData,
        readout,
        valueMode,
      }),
    [axisMode, chart, displayedChartData, readout, valueMode],
  );
  const detailPoint =
    chartData.find((point) => point.runNumber === selectedRunNumber) || chartData.at(-1) || null;
  const openPoint = (point: ChartDatum, opener: ChartPointOpener) => {
    setSelectedRunNumber(point.runNumber);
    modalOpenerRef.current = opener;
    modalOpenerSelectorRef.current = "#trend-chart-range";
    setOpenedPoint(point);
  };
  const closePoint = () => {
    flushSync(() => {
      setOpenedPoint(null);
    });
    setRestoreFocusTick((value) => value + 1);
  };
  useEffect(() => {
    if (!restoreFocusTick) return;
    restoreChartPointFocus(modalOpenerRef.current, modalOpenerSelectorRef.current);
  }, [restoreFocusTick]);
  return (
    <section
      className="panel trend-panel"
      id="trend-panel"
      aria-label="Evidence trail"
      tabIndex={-1}
      ref={panelRef}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Evidence trail</p>
          <h2>Packet trend</h2>
        </div>
        <ChartControls
          axisMode={axisMode}
          metricDefinition={readout.metricDefinition}
          setAxisMode={setAxisMode}
          setValueMode={setValueMode}
          valueMode={valueMode}
        />
        <span id="chart-note" className="panel-note">
          {chart.note}
        </span>
      </div>

      <StatusLegend />

      <TrendChartFigure
        chart={chart}
        chartData={displayedChartData}
        chartHeight={chartHeight}
        chartState={chartState}
        onPointSelect={openPoint}
        onPointPreview={setSelectedRunNumber}
        readout={readout}
        selectedRunNumber={selectedRunNumber}
        totalPointCount={chartData.length}
        valueMode={valueMode}
      />

      <p id="trend-chart-summary" className="sr-summary">
        {chart.summary}
      </p>
      {detailsDefaultOpen ? (
        <MetricDetails readout={readout} session={session} point={detailPoint} />
      ) : (
        <details className="metric-details-disclosure">
          <summary>How this metric is computed</summary>
          <MetricDetails readout={readout} session={session} point={detailPoint} />
        </details>
      )}

      {openedPoint && (
        <ExperimentModal
          point={openedPoint}
          valueMode={valueMode}
          readout={readout}
          onClose={closePoint}
        />
      )}
    </section>
  );
}
