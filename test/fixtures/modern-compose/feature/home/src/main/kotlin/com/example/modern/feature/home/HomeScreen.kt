package com.example.modern.feature.home

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

@Composable
fun HomeScreen(state: HomeUiState) {
    Text(text = state.title)
}
