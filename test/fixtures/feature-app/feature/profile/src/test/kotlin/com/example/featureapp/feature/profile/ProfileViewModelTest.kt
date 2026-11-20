package com.example.featureapp.feature.profile

class ProfileViewModelTest {
    fun initialNameIsEmpty() {
        check(ProfileViewModel().name.value == "")
    }
}
