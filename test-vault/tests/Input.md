## Template

The template path itself is made available as part of the `input` variable.

%%{ template: 'input-template.js' }%%
Input template: input-template.js
%% %%

## Name

%%{ template: 'input-name.js' }%%
My name is undefined.
%% %%

%%{ template: 'input-name.js', name: 'Nate' }%%
My name is Nate.
%% %%

## Objects

%%{ template: 'input-objects.js', list: [1, 2, 3], obj: { foo: 'bar'} }%%
Input: {"template":"input-objects.js","list":[1,2,3],"obj":{"foo":"bar"}}
%% %%
