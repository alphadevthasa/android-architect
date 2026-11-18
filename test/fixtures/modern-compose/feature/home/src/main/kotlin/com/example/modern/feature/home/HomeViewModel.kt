package com.example.modern.feature.home

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class HomeUiState(val title: String = "")

class HomeViewModel : ViewModel() {
    private val _state = MutableStateFlow<HomeUiState>(HomeUiState())
    val state: StateFlow<HomeUiState> = _state
}
