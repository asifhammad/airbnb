#!/usr/bin/env python3
"""
Unit tests for place_type normalization.
"""

from src.python.search_listings import normalize_place_type


def test_normalize_place_type_entire_home():
    assert normalize_place_type("Entire home") == "Entire home/apt"
    assert normalize_place_type("entire_home") == "Entire home/apt"
    assert normalize_place_type("ENTIRE HOME/APT") == "Entire home/apt"


def test_normalize_place_type_private_room():
    assert normalize_place_type("Private room") == "Private room"
    assert normalize_place_type("private_room") == "Private room"


def test_normalize_place_type_passthrough():
    assert normalize_place_type("") == ""
    assert normalize_place_type(None) is None
