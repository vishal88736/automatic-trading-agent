"""
webui/components/safety_panel.py - Production safety layer status panel

Shows a green/red badge for every deterministic guard (kill switch,
pre-trade checks, circuit breakers, LLM budget) plus a kill-switch toggle
that halts all order flow immediately, regardless of agent decisions.
"""

import dash_bootstrap_components as dbc
from dash import dcc, html


def create_safety_panel():
    """Create the safety guardrails card for the web UI."""
    return dbc.Card(
        dbc.CardBody(
            [
                dbc.Row(
                    [
                        dbc.Col(
                            [
                                html.H4("Safety Guardrails", className="mb-1"),
                                html.Div(
                                    "Deterministic pre-trade checks, circuit breakers, and a "
                                    "kill switch — enforced before any order reaches the broker, "
                                    "independent of agent decisions.",
                                    className="text-muted small",
                                ),
                            ],
                            md=8,
                        ),
                        dbc.Col(
                            [
                                dbc.ButtonGroup(
                                    [
                                        dbc.Button(
                                            [
                                                html.I(className="fas fa-hand-paper me-2"),
                                                "Engage Kill Switch",
                                            ],
                                            id="safety-kill-switch-btn",
                                            color="danger",
                                            size="sm",
                                        ),
                                        dbc.Button(
                                            "Release",
                                            id="safety-release-btn",
                                            color="secondary",
                                            outline=True,
                                            size="sm",
                                        ),
                                    ],
                                    className="float-end",
                                ),
                            ],
                            md=4,
                        ),
                    ],
                    className="mb-3 align-items-start",
                ),
                html.Div(id="safety-action-status", className="mb-2"),
                html.Div(id="safety-status-container"),
                dcc.Interval(
                    id="safety-refresh-interval",
                    interval=30_000,  # 30s
                    n_intervals=0,
                ),
            ]
        ),
        className="mb-4",
    )
